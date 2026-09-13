/**
 * §8.9 rows 9.8 / 9.9 — rung-5 REACHABILITY for "a correction sticks" and
 * "undo a lesson it learned wrong".
 *
 * There is no dedicated screen for corrections anywhere in packages/web —
 * the only real surface is the SAME estimate-proposal edit→approve→execute
 * pipeline every AI-drafted estimate goes through (`PUT /api/proposals/:id`
 * = `editProposal`, `POST /api/proposals/:id/approve` = `approveProposal`,
 * then the REAL production execution registry the auto-delivery worker uses
 * — `createExecutionHandlerRegistry` + `ProposalExecutor`, the same classes
 * `correction-repetition-meta-proposal.test.ts` calls "the PRODUCTION
 * registry + executor"). This file drives that real pipeline end to end,
 * with the SAME `recordCorrectionLessonsOnExecution` wired into `onExecuted`
 * exactly as `app.ts` wires it.
 *
 * FINDING (test.fails below, both real-Postgres, real-pipeline runs):
 *   `ProposalExecutor.execute()` always writes
 *   `executedPayload: keyedProposal.payload` (executor.ts:279 and :427) —
 *   literally the SAME object `recordCorrectionLessonsOnExecution` reads as
 *   `drafted` a moment later, in the same onExecuted callback
 *   (record-on-execution.ts:114-115: `drafted = proposal.payload`,
 *   `executed = execution.executedPayload`). Because `editProposal` (the
 *   route the owner's "correction" goes through) mutates `proposal.payload`
 *   IN PLACE *before* approval, by the time execution runs, `proposal.
 *   payload` already IS the corrected value — so `drafted === executed`
 *   (same values, often the same object), `computeInvoiceDeltas` sees zero
 *   line differences, and `record-on-execution.ts:126`
 *   (`if (deltas.length === 0) return [];`) always short-circuits. Every
 *   PASSING test of `recordCorrectionLessonsOnExecution` in this repo
 *   (test/integration/correction-lesson-on-execution.test.ts,
 *   test/learning/corrections/record-on-execution.test.ts) manually inserts
 *   a `proposal_executions` row with a HAND-DIVERGENT `executedPayload` —
 *   nothing in the real approve→execute pipeline can ever produce that
 *   divergence. Net: rows 9.8 and 9.9's entire mechanism is wired and
 *   audited, but is NEVER INVOKED by any real product path today. This is a
 *   product gap, not a test gap — reported here per §12.4d, not filed by
 *   this lane.
 *
 * 9.9 is doubly unreachable: even granting a lesson existed, `undoProposal`
 * (proposals/actions.ts:512-515) refuses any proposal whose status is not
 * 'approved' — and a lesson can only ever be recorded in `onExecuted`,
 * which fires strictly AFTER the proposal has already transitioned to
 * 'executed' (past `UNDO_WINDOW_MS`, proposals/lifecycle.ts:53). There is no
 * tick of real time at which a real lesson exists AND its source proposal
 * is still undoable.
 *
 * What DOES work, and is proven here as the positive case: the owner's
 * edit-before-approve mechanism itself is real end to end — the estimate
 * that gets created carries the OWNER-CORRECTED price, not the AI's
 * original draft, through the real routes' own functions and the real
 * production execution registry, with a second tenant's catalog/estimate
 * untouched (T2).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgCorrectionLessonRepository } from '../../src/learning/corrections/pg-correction-lesson';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createProposal } from '../../src/proposals/proposal';
import { editProposal, approveProposal, undoProposal } from '../../src/proposals/actions';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { recordCorrectionLessonsOnExecution } from '../../src/learning/corrections/record-on-execution';
import type { ConfigPorts } from '../../src/learning/corrections/lesson-applicator';

async function seedJob(
  pool: Pool,
  tenantId: string,
  userId: string,
): Promise<{ jobId: string; customerId: string }> {
  const customerId = uuidv4();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, 'Estimate Customer', $3)`,
    [customerId, tenantId, userId],
  );
  const locationId = uuidv4();
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, $3, '1 Main St', 'Austin', 'TX', '78701')`,
    [locationId, tenantId, customerId],
  );
  const jobId = uuidv4();
  await pool.query(
    `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
     VALUES ($1, $2, $3, $4, $5, 'Job for estimate', $6)`,
    [jobId, tenantId, customerId, locationId, 'JOB-' + jobId.slice(0, 8), userId],
  );
  return { jobId, customerId };
}

function makePorts(catalogRepo: PgCatalogItemRepository, laborItemId: string): ConfigPorts {
  return {
    async setLaborRateCents(tenantId, cents) {
      if (cents === null) return;
      await catalogRepo.update(tenantId, laborItemId, { unitPriceCents: cents });
    },
    async setSkuPriceCents(tenantId, catalogItemId, cents) {
      await catalogRepo.update(tenantId, catalogItemId, { unitPriceCents: cents });
    },
    async setBannedPhrases() {},
    async setTemplateWeight() {},
  };
}

describe('9.8/9.9 reachability — real edit→approve→execute pipeline for a labor-rate correction', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let catalogRepo: PgCatalogItemRepository;
  let lessonRepo: PgCorrectionLessonRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    lessonRepo = new PgCorrectionLessonRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function driveRealPipeline(
    tenantId: string,
    userId: string,
    jobId: string,
    customerId: string,
    ownerCorrectedCents: number,
  ) {
    await settingsRepo.create({
      id: uuidv4(),
      tenantId,
      businessName: 'Correction Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // AI-drafted proposal (seeded — no live model call; see e2e preamble
    // #1119). Labor line at $115/hr, exactly as an AI draft would price it.
    const draft = createProposal({
      tenantId,
      proposalType: 'draft_estimate',
      payload: {
        jobId,
        customerId,
        lineItems: [
          {
            id: 'l1',
            description: 'Standard Labor',
            category: 'labor',
            quantity: 1,
            unitPriceCents: 11500,
            totalCents: 11500,
            sortOrder: 0,
            taxable: true,
          },
        ],
      },
      summary: 'Estimate for job',
      createdBy: userId,
    });
    await proposalRepo.create(draft);

    // REAL route function: PUT /api/proposals/:id → editProposal. The owner
    // corrects the labor line from $115 to the given price BEFORE approving.
    const { proposal: edited } = await editProposal(
      proposalRepo,
      tenantId,
      draft.id,
      userId,
      'owner',
      {
        lineItems: [
          {
            id: 'l1',
            description: 'Standard Labor',
            category: 'labor',
            quantity: 1,
            unitPriceCents: ownerCorrectedCents,
            totalCents: ownerCorrectedCents,
            sortOrder: 0,
            taxable: true,
          },
        ],
      },
      auditRepo,
    );
    expect((edited.payload.lineItems as Array<{ unitPriceCents: number }>)[0].unitPriceCents).toBe(
      ownerCorrectedCents,
    );

    // REAL route function: POST /api/proposals/:id/approve.
    const approved = await approveProposal(proposalRepo, tenantId, draft.id, userId, 'owner', auditRepo);
    expect(approved.status).toBe('approved');
    // Past the 5-second undo window (Decision 9) — in production this is
    // real wall-clock elapsed while the owner reads the confirmation and the
    // auto-delivery worker's own sweep cadence passes; backdating here is
    // the SAME idiom correction-repetition-meta-proposal.test.ts and
    // service-credit-cap-9-5.test.ts use to drive execution without a real
    // sleep. `undoProposal` (9.9, below) is what actually enforces the
    // window — the executor enforces it too (executor.ts:105-113).
    await proposalRepo.updateStatus(tenantId, draft.id, 'approved', {
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    });

    // REAL production execution registry + executor (same classes
    // correction-repetition-meta-proposal.test.ts calls "the PRODUCTION
    // registry + executor"), wired with `onExecuted` calling
    // recordCorrectionLessonsOnExecution exactly as app.ts does.
    const registry = createExecutionHandlerRegistry({ estimateRepo, settingsRepo, auditRepo });
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    let onExecutedRan = false;
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo, {
      executionRepo,
      onExecuted: async (event) => {
        if (event.status !== 'succeeded') return;
        onExecutedRan = true;
        await recordCorrectionLessonsOnExecution(
          { tenantId: event.tenantId, proposalId: event.proposalId },
          {
            proposalRepo,
            proposalExecutionRepo: executionRepo,
            settingsRepo,
            lessonRepo,
            catalogRepo,
            ports: makePorts(catalogRepo, 'unused'),
            auditRepo,
          },
        );
      },
    });

    const refetched = await proposalRepo.findById(tenantId, draft.id);
    const { result } = await executor.execute(refetched!, { tenantId, executedBy: userId });
    expect(result.success).toBe(true);
    expect(onExecutedRan).toBe(true);

    return { proposalId: draft.id, estimateId: result.resultEntityId! };
  }

  it('POSITIVE: the real edit→approve→execute pipeline creates the estimate at the OWNER-CORRECTED price — a neighbour tenant is untouched (T2)', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const { jobId: jobA, customerId: customerA } = await seedJob(pool, tenantA.tenantId, tenantA.userId);
    const { jobId: jobB, customerId: customerB } = await seedJob(pool, tenantB.tenantId, tenantB.userId);

    const resA = await driveRealPipeline(tenantA.tenantId, tenantA.userId, jobA, customerA, 13500);
    const resB = await driveRealPipeline(tenantB.tenantId, tenantB.userId, jobB, customerB, 9900);

    const estimateA = await estimateRepo.findById(tenantA.tenantId, resA.estimateId);
    expect(estimateA!.lineItems[0].unitPriceCents).toBe(13500);
    const estimateB = await estimateRepo.findById(tenantB.tenantId, resB.estimateId);
    expect(estimateB!.lineItems[0].unitPriceCents).toBe(9900);

    // T2: tenant A cannot read tenant B's estimate under its own tenant id.
    const crossRead = await estimateRepo.findById(tenantA.tenantId, resB.estimateId);
    expect(crossRead).toBeNull();
  });

  it.fails(
    '9.8 DESIRED (currently FAILS — product gap, see file header): a real owner correction through the real pipeline should record a correction_lesson, but executedPayload always mirrors proposal.payload (executor.ts:279/427), so the diff (record-on-execution.ts:114-126) is always empty',
    async () => {
      const tenant = await createTestTenant(pool);
      const { jobId, customerId } = await seedJob(pool, tenant.tenantId, tenant.userId);
      const { proposalId } = await driveRealPipeline(tenant.tenantId, tenant.userId, jobId, customerId, 13500);

      const lessons = await lessonRepo.findBySourceProposal(tenant.tenantId, proposalId);
      // DESIRED: a labor_rate_changed lesson recorded from this real
      // correction. ACTUAL today: always [].
      expect(lessons.length).toBeGreaterThan(0);
    },
  );

  it.fails(
    "9.9 DESIRED (currently FAILS — product gap, see file header): even granting a lesson existed, undoProposal should be able to reverse it after real execution — but it refuses any proposal whose status isn't 'approved' (actions.ts:512-515), and a lesson can only ever exist after execution (status already 'executed')",
    async () => {
      const tenant = await createTestTenant(pool);
      const { jobId, customerId } = await seedJob(pool, tenant.tenantId, tenant.userId);
      const { proposalId } = await driveRealPipeline(tenant.tenantId, tenant.userId, jobId, customerId, 13500);

      // Manually seed the lesson the real pipeline can never produce (see the
      // 9.8 test above), tied to the REAL, really-executed proposal, so THIS
      // test isolates the undo-reachability question alone.
      const { buildCorrectionLesson } = await import('../../src/learning/corrections/correction-lesson');
      const lesson = buildCorrectionLesson({
        id: uuidv4(),
        tenantId: tenant.tenantId,
        lessonType: 'labor_rate_changed',
        sourceProposalId: proposalId,
        ownerId: tenant.userId,
        summary: 'labor rate change',
        payload: { kind: 'labor_rate_changed', beforeCents: 11500, afterCents: 13500 },
        localDate: '2026-06-14',
      });
      await lessonRepo.create(lesson);

      // DESIRED: the owner can undo it through the real proposal-undo route.
      // ACTUAL today: the proposal is already 'executed' — undoProposal
      // throws a ValidationError before it ever reaches the
      // undoCorrectionLesson block.
      const undone = await undoProposal(proposalRepo, tenant.tenantId, proposalId, tenant.userId, 'owner', auditRepo, {
        lessonRepo,
        ports: makePorts(catalogRepo, 'unused'),
      });
      expect(undone.status).toBe('undone');
    },
  );
});
