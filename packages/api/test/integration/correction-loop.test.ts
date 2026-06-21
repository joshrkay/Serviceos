/**
 * N-009 / P2-038 — Correction-loop integration (Docker-gated).
 *
 * Pins the REAL schema (a mocked Pool is not proof the columns exist):
 *   - correction_lessons columns + FORCE RLS isolate across tenants.
 *   - a labor-rate edit applied through the loop changes what the NEXT
 *     same-day draft would price: the labor catalog item the catalog
 *     resolver grounds against now resolves to the corrected rate.
 *
 * NOTE: Docker Hub pulls are rate-limited locally, so vitest globalSetup may
 * fail to start the testcontainer here — that's expected; this file is
 * authored for CI (test/integration runs in PR CI).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCorrectionLessonRepository } from '../../src/learning/corrections/pg-correction-lesson';
import {
  recordCorrectionLessons,
  undoCorrectionLesson,
} from '../../src/learning/corrections/apply-undo';
import type { ConfigPorts } from '../../src/learning/corrections/lesson-applicator';
import { extractCorrectionLessons } from '../../src/learning/corrections/correction-extractor';
import { buildCorrectionLessonDrafts } from '../../src/learning/corrections/build-correction-drafts';
import {
  PgCatalogItemRepository,
} from '../../src/catalog/pg-catalog-item';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import { resolveLineItemToCatalog } from '../../src/ai/resolution/catalog-resolver';
import { PgAuditRepository } from '../../src/audit/pg-audit';

/**
 * Real ConfigPorts for the integration: labor rate is realized as the tenant's
 * labor catalog item price (what the catalog resolver grounds drafts against).
 * Other ports are no-ops here — the labor path is the one we pin against the DB.
 */
function makePorts(catalogRepo: PgCatalogItemRepository, laborItemId: string): ConfigPorts {
  return {
    async setLaborRateCents(tenantId, cents) {
      if (cents === null) return;
      await catalogRepo.update(tenantId, laborItemId, { unitPriceCents: cents });
    },
    async setSkuPriceCents(tenantId, catalogItemId, cents) {
      await catalogRepo.update(tenantId, catalogItemId, { unitPriceCents: cents });
    },
    async setBannedPhrases() {
      /* exercised in unit tests; not pinned here */
    },
    async setTemplateWeight() {
      /* exercised in unit tests; not pinned here */
    },
  };
}

describe('Postgres integration — correction loop (migration 180)', () => {
  let pool: Pool;
  let lessonRepo: PgCorrectionLessonRepository;
  let catalogRepo: PgCatalogItemRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    lessonRepo = new PgCorrectionLessonRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a lesson with real columns and a labor edit changes the next same-day draft', async () => {
    // Seed the tenant labor catalog item the resolver will ground against.
    const labor = createCatalogItem({
      tenantId: tenant.tenantId,
      name: 'Standard Labor',
      category: 'Labor',
      unit: 'hour',
      unitPriceCents: 11500,
    });
    await catalogRepo.create(labor);

    // Owner edits a labor line from $115 to $135/hr.
    const drafts = extractCorrectionLessons({
      deltas: [{ type: 'price_changed', lineItemId: 'li-1', oldValue: 11500, newValue: 13500 }],
      lineItems: [{ id: 'li-1', category: 'labor' }],
      config: {
        laborRateCents: 11500,
        skuPriceCents: {},
        bannedPhrases: [],
        templateWeights: {},
      },
    });
    expect(drafts).toHaveLength(1);

    const ports = makePorts(catalogRepo, labor.id);
    const [lesson] = await recordCorrectionLessons(
      {
        tenantId: tenant.tenantId,
        sourceProposalId: crypto.randomUUID(),
        ownerId: tenant.userId,
        localDate: '2026-06-14',
        drafts,
      },
      { repository: lessonRepo, ports, auditRepo },
    );

    // Row persisted with the real columns.
    const stored = await lessonRepo.findById(tenant.tenantId, lesson.id);
    expect(stored).not.toBeNull();
    expect(stored!.lessonType).toBe('labor_rate_changed');
    expect(stored!.status).toBe('applied');
    expect(stored!.localDate).toBe('2026-06-14');
    expect(stored!.payload).toMatchObject({ kind: 'labor_rate_changed', afterCents: 13500 });

    // Surfaced for the day (drives the digest "what I learned today").
    const forDay = await lessonRepo.findAppliedForDay(tenant.tenantId, '2026-06-14');
    expect(forDay.map((l) => l.id)).toContain(lesson.id);

    // Audit emitted on apply.
    const applyAudits = await auditRepo.findByEntity(tenant.tenantId, 'correction_lesson', lesson.id);
    expect(applyAudits.some((a) => a.eventType === 'correction_lesson.applied')).toBe(true);

    // Forward application: the NEXT draft grounding "labor" now resolves $135.
    const activeItems = await catalogRepo.listByTenant(tenant.tenantId);
    const resolution = resolveLineItemToCatalog('Standard Labor', activeItems);
    expect(resolution.tier === 'exact' || resolution.tier === 'high').toBe(true);
    expect(resolution.match?.unitPriceCents).toBe(13500);

    // Undo reverses both the lesson and the cascaded catalog price.
    const reverted = await undoCorrectionLesson(
      { tenantId: tenant.tenantId, lessonId: lesson.id, ownerId: tenant.userId },
      { repository: lessonRepo, ports, auditRepo },
    );
    expect(reverted!.status).toBe('reverted');
    const afterUndo = await catalogRepo.listByTenant(tenant.tenantId);
    const laborAfter = afterUndo.find((i) => i.id === labor.id);
    expect(laborAfter!.unitPriceCents).toBe(11500);
    const undoAudits = await auditRepo.findByEntity(tenant.tenantId, 'correction_lesson', lesson.id);
    expect(undoAudits.some((a) => a.eventType === 'correction_lesson.reverted')).toBe(true);
  });

  it('FORCE RLS isolates correction_lessons across tenants', async () => {
    const drafts = extractCorrectionLessons({
      deltas: [{ type: 'price_changed', lineItemId: 'li-1', oldValue: 11500, newValue: 14000 }],
      lineItems: [{ id: 'li-1', category: 'labor' }],
      config: { laborRateCents: 11500, skuPriceCents: {}, bannedPhrases: [], templateWeights: {} },
    });
    const labor = createCatalogItem({
      tenantId: tenant.tenantId,
      name: 'RLS Labor',
      category: 'Labor',
      unit: 'hour',
      unitPriceCents: 11500,
    });
    await catalogRepo.create(labor);
    const ports = makePorts(catalogRepo, labor.id);
    const [lesson] = await recordCorrectionLessons(
      {
        tenantId: tenant.tenantId,
        sourceProposalId: crypto.randomUUID(),
        ownerId: tenant.userId,
        localDate: '2026-06-14',
        drafts,
      },
      { repository: lessonRepo, ports, auditRepo },
    );

    const other = await createTestTenant(pool);
    expect(await lessonRepo.findById(other.tenantId, lesson.id)).toBeNull();
    expect(await lessonRepo.findAppliedForDay(other.tenantId, '2026-06-14')).toHaveLength(0);
  });

  it('executor path: a drafted-vs-executed payload edit cascades, and the next same-day draft reflects it', async () => {
    // Mirrors the app.ts onExecuted wiring: the structured drafts come from the
    // SHARED bridge over the immutable drafted payload vs. the as-executed
    // payload — not from a hand-built delta. This is the production seam.
    const labor = createCatalogItem({
      tenantId: tenant.tenantId,
      name: 'Bridge Labor',
      category: 'Labor',
      unit: 'hour',
      unitPriceCents: 12000,
    });
    await catalogRepo.create(labor);

    const draftedPayload = {
      lineItems: [
        { id: 'li-1', description: 'Bridge Labor', category: 'labor', quantity: 1, unitPriceCents: 12000, totalCents: 12000, sortOrder: 0, taxable: true },
      ],
    };
    const executedPayload = {
      lineItems: [
        { id: 'li-1', description: 'Bridge Labor', category: 'labor', quantity: 1, unitPriceCents: 14000, totalCents: 14000, sortOrder: 0, taxable: true },
      ],
    };

    const drafts = buildCorrectionLessonDrafts(
      { drafted: draftedPayload, executed: executedPayload },
      { laborRateCents: 12000, skuPriceCents: {}, bannedPhrases: [], templateWeights: {} },
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].lessonType).toBe('labor_rate_changed');

    const ports = makePorts(catalogRepo, labor.id);
    const sourceProposalId = crypto.randomUUID();
    const [lesson] = await recordCorrectionLessons(
      {
        tenantId: tenant.tenantId,
        sourceProposalId,
        ownerId: tenant.userId,
        localDate: '2026-06-14',
        drafts,
      },
      { repository: lessonRepo, ports, auditRepo },
    );

    // The NEXT same-day draft grounding "Bridge Labor" now resolves $140.
    const activeItems = await catalogRepo.listByTenant(tenant.tenantId);
    const resolution = resolveLineItemToCatalog('Bridge Labor', activeItems);
    expect(resolution.match?.unitPriceCents).toBe(14000);

    // Undo via the source-proposal reverse lookup (the undoProposal wiring).
    const linked = await lessonRepo.findBySourceProposal(tenant.tenantId, sourceProposalId);
    expect(linked.map((l) => l.id)).toContain(lesson.id);
    for (const l of linked) {
      await undoCorrectionLesson(
        { tenantId: tenant.tenantId, lessonId: l.id, ownerId: tenant.userId },
        { repository: lessonRepo, ports, auditRepo },
      );
    }
    const afterUndo = await catalogRepo.listByTenant(tenant.tenantId);
    expect(afterUndo.find((i) => i.id === labor.id)!.unitPriceCents).toBe(12000);
    expect(await lessonRepo.findAppliedForDay(tenant.tenantId, '2026-06-14')).not.toContain(
      lesson.id,
    );
  });

  it('findBySourceProposal returns every lesson a proposal recorded (drives undo)', async () => {
    const sourceProposalId = crypto.randomUUID();
    const drafts = buildCorrectionLessonDrafts(
      {
        drafted: { lineItems: [{ id: 'li-1', description: 'L', category: 'labor', quantity: 1, unitPriceCents: 10000, totalCents: 10000, sortOrder: 0, taxable: true }], customerMessage: 'Hi — cheapest in town guaranteed' },
        executed: { lineItems: [{ id: 'li-1', description: 'L', category: 'labor', quantity: 1, unitPriceCents: 11000, totalCents: 11000, sortOrder: 0, taxable: true }], customerMessage: 'Hi' },
      },
      { laborRateCents: 10000, skuPriceCents: {}, bannedPhrases: [], templateWeights: {} },
    );
    // Two distinct lessons from one edit: labor rate + banned phrase.
    expect(drafts.length).toBe(2);

    const ports = makePorts(catalogRepo, crypto.randomUUID());
    await recordCorrectionLessons(
      {
        tenantId: tenant.tenantId,
        sourceProposalId,
        ownerId: tenant.userId,
        localDate: '2026-06-14',
        drafts,
      },
      { repository: lessonRepo, ports, auditRepo },
    );

    const linked = await lessonRepo.findBySourceProposal(tenant.tenantId, sourceProposalId);
    expect(linked).toHaveLength(2);
    expect(new Set(linked.map((l) => l.lessonType))).toEqual(
      new Set(['labor_rate_changed', 'banned_phrase']),
    );
    // Cross-tenant isolation on the reverse lookup too.
    const other = await createTestTenant(pool);
    expect(await lessonRepo.findBySourceProposal(other.tenantId, sourceProposalId)).toHaveLength(0);
  });
});
