/**
 * WS20 integration — correction-repetition meta-proposal end-to-end on real Postgres.
 *
 * Pins (a) PgCorrectionLessonRepository.countByTarget (JSONB payload query),
 * (b) PgProposalRepository.findByCorrectionTarget (source_context JSONB query),
 * and (c) the full loop: three same-SKU price corrections → detector emits ONE
 * update_catalog_item proposal (ready_for_review) → approve → run through the
 * PRODUCTION execution registry + ProposalExecutor → the catalog SKU price is
 * updated and both catalog_item.updated + proposal.executed audits land.
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgCorrectionLessonRepository } from '../../src/learning/corrections/pg-correction-lesson';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildCorrectionLesson } from '../../src/learning/corrections/correction-lesson';
import { detectCorrectionRepetition } from '../../src/learning/corrections/correction-repetition';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import type { CatalogItem } from '../../src/catalog/catalog-item';

describe('Postgres integration — WS20 correction-repetition meta-proposal', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let catalogRepo: PgCatalogItemRepository;
  let proposalRepo: PgProposalRepository;
  let lessonRepo: PgCorrectionLessonRepository;
  let auditRepo: PgAuditRepository;
  const catalogItemId = crypto.randomUUID();

  function catalogItem(unitPriceCents: number): CatalogItem {
    const now = new Date().toISOString();
    return {
      id: catalogItemId,
      tenantId: tenant.tenantId,
      name: 'Smoke Detector',
      description: '',
      category: 'Materials',
      unit: 'each',
      unitPriceCents,
      productServiceType: 'product',
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  async function seedLesson(afterCents: number, beforeCents: number, createdAt: Date) {
    const lesson = buildCorrectionLesson({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      lessonType: 'part_price_changed',
      sourceProposalId: crypto.randomUUID(),
      ownerId: tenant.userId,
      summary: 'price change',
      payload: { kind: 'part_price_changed', catalogItemId, beforeCents, afterCents },
      localDate: '2026-07-11',
    });
    await lessonRepo.create({ ...lesson, createdAt });
    return lesson;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    lessonRepo = new PgCorrectionLessonRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    await catalogRepo.create(catalogItem(10000));
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('countByTarget counts same-SKU part_price lessons (JSONB query, real columns)', async () => {
    await seedLesson(8900, 10000, new Date('2026-07-11T01:00:00Z'));
    await seedLesson(8900, 10000, new Date('2026-07-11T02:00:00Z'));
    const two = await lessonRepo.countByTarget(tenant.tenantId, 'part_price_changed', catalogItemId);
    expect(two).toBe(2);
    // A different SKU is not counted.
    const other = await lessonRepo.countByTarget(
      tenant.tenantId,
      'part_price_changed',
      crypto.randomUUID(),
    );
    expect(other).toBe(0);
  });

  it('full loop: 3rd correction → meta-proposal → approve → executor updates catalog', async () => {
    // Third same-SKU correction crosses the threshold.
    const trigger = await seedLesson(8900, 10000, new Date('2026-07-11T03:00:00Z'));
    expect(await lessonRepo.countByTarget(tenant.tenantId, 'part_price_changed', catalogItemId)).toBe(3);

    const emitted = await detectCorrectionRepetition(
      { tenantId: tenant.tenantId, recordedLessons: [trigger] },
      { lessonRepo, proposalRepo, catalogRepo, auditRepo },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].proposalType).toBe('update_catalog_item');
    expect(emitted[0].status).toBe('ready_for_review');

    // Pg dedup reader finds the open proposal by correction target.
    const open = await proposalRepo.findByCorrectionTarget(
      tenant.tenantId,
      'update_catalog_item',
      { kind: 'part_price', key: catalogItemId },
      ['draft', 'ready_for_review'],
    );
    expect(open.map((p) => p.id)).toContain(emitted[0].id);

    // Approve (past the undo window) and run the PRODUCTION registry + executor.
    let proposal = transitionProposal(emitted[0], 'approved', tenant.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.updateStatus(tenant.tenantId, proposal.id, 'approved', {
      approvedAt: proposal.approvedAt,
    });

    const registry = createExecutionHandlerRegistry({ catalogRepo, auditRepo });
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const { result } = await executor.execute(proposal, {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    });
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(catalogItemId);

    // Catalog SKU price durably updated.
    const item = await catalogRepo.findById(tenant.tenantId, catalogItemId);
    expect(item?.unitPriceCents).toBe(8900);

    // Both audits: the catalog change and the WS11 execution outcome.
    const catAudits = await auditRepo.findByEntity(tenant.tenantId, 'catalog_item', catalogItemId);
    expect(catAudits.some((a) => a.eventType === 'catalog_item.updated')).toBe(true);
    const propAudits = await auditRepo.findByEntity(tenant.tenantId, 'proposal', proposal.id);
    expect(propAudits.some((a) => a.eventType === 'proposal.executed')).toBe(true);
  });
});
