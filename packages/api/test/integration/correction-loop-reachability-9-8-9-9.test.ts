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
 * HISTORY — the two pins below were `it.fails` (PR #1138) until #1139:
 *   `ProposalExecutor.execute()` writes `executedPayload: keyedProposal.
 *   payload` (executor.ts, the in-guard recordExecution) — and that IS what
 *   was executed. The defect was on the other side of the diff:
 *   `recordCorrectionLessonsOnExecution` read `drafted = proposal.payload`,
 *   but `editProposal` (the route the owner's "correction" goes through)
 *   OVERWRITES `proposal.payload` with the corrected value before approval,
 *   so the AI's draft was gone and `drafted === executed` on every real
 *   run — `computeInvoiceDeltas` saw zero differences and no lesson was
 *   ever recorded. Every PASSING test of the recorder
 *   (correction-lesson-on-execution.test.ts, the unit suite) hand-inserted
 *   a divergent `proposal_executions` row.
 *
 *   FIX (#1139): `editProposal` now preserves the payload AS FIRST PROPOSED
 *   in `proposals.original_payload` (migration 275, written once, on the
 *   first edit that changes a field), and the recorder diffs
 *   `originalPayload ?? payload` against the executed payload. The executor
 *   and `executed_payload` are unchanged in meaning (see
 *   executor-executed-payload-money-guard-1139.test.ts).
 *
 * 9.9 was doubly unreachable: `undoProposal` refuses any proposal whose
 * status is not 'approved', and a lesson only exists after the proposal is
 * 'executed' (terminal in lifecycle.ts). FIX (#1139): the approval undo
 * keeps that refusal — an executed proposal is NOT undone and its estimate
 * stays — but an explicit `{ scope: 'lessons' }` undo (POST
 * /api/proposals/:id/undo with that body) reverses the lessons an executed
 * proposal recorded and the tenant config each cascaded. It requires
 * `settings:update` because it writes tenant config.
 *
 * Ports: these tests use `createPgConfigPorts` — the same settings/catalog
 * stores app.ts's `correctionConfigPorts` write — so the cascade (tenant
 * labor rate) and its reversal are observed in real rows, not a fake.
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
import { ValidationError } from '../../src/shared/errors';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { recordCorrectionLessonsOnExecution } from '../../src/learning/corrections/record-on-execution';
import { createPgConfigPorts } from '../../src/learning/corrections/pg-config-ports';
import type { ConfigPorts } from '../../src/learning/corrections/lesson-applicator';
import { createCatalogItem } from '../../src/catalog/catalog-item';
import type { Role } from '../../src/auth/rbac';

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

describe('9.8/9.9 reachability — real edit→approve→execute pipeline for a labor-rate correction', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let catalogRepo: PgCatalogItemRepository;
  let lessonRepo: PgCorrectionLessonRepository;
  let auditRepo: PgAuditRepository;
  // The production-equivalent ConfigPorts (the same stores app.ts's
  // correctionConfigPorts write): labor rate → tenant_settings.
  let ports: ConfigPorts;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    lessonRepo = new PgCorrectionLessonRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    ports = createPgConfigPorts({ settingsRepo, catalogRepo });
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
    // The tenant's configured labor rate is $115/hr — the price the AI draft
    // below grounds its labor line on. (settingsRepo.create does not persist
    // this column, so it is set through the real update path.)
    await settingsRepo.update(tenantId, { laborRateCentsPerHour: 11500 });

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
            ports,
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

  it('9.8: a real owner correction through the real edit→approve→execute pipeline records a correction_lesson (AI draft vs executed payload) and cascades it into tenant config — a neighbour tenant (T2) with a divergent correction keeps its own lesson and rate', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const { jobId: jobA, customerId: customerA } = await seedJob(pool, tenantA.tenantId, tenantA.userId);
    const { jobId: jobB, customerId: customerB } = await seedJob(pool, tenantB.tenantId, tenantB.userId);

    const resA = await driveRealPipeline(tenantA.tenantId, tenantA.userId, jobA, customerA, 13500);
    const resB = await driveRealPipeline(tenantB.tenantId, tenantB.userId, jobB, customerB, 9900);

    // The lesson — recorded by the REAL onExecuted → recorder path, not seeded.
    const lessonsA = await lessonRepo.findBySourceProposal(tenantA.tenantId, resA.proposalId);
    expect(lessonsA).toHaveLength(1);
    expect(lessonsA[0].lessonType).toBe('labor_rate_changed');
    expect(lessonsA[0].status).toBe('applied');
    expect(lessonsA[0].payload).toEqual({ kind: 'labor_rate_changed', beforeCents: 11500, afterCents: 13500 });

    // Where the diff's two sides live: the AI draft is preserved on the
    // proposal (original_payload); the executed value is the proposal's
    // payload AND the execution row's executed_payload.
    const proposalA = await proposalRepo.findById(tenantA.tenantId, resA.proposalId);
    const originalA = proposalA!.originalPayload as { lineItems: Array<{ unitPriceCents: number }> };
    expect(originalA.lineItems[0].unitPriceCents).toBe(11500);
    expect((proposalA!.payload.lineItems as Array<{ unitPriceCents: number }>)[0].unitPriceCents).toBe(13500);
    const executionA = await executionRepo.findLatestByProposal(tenantA.tenantId, resA.proposalId);
    expect(executionA!.status).toBe('succeeded');
    expect((executionA!.executedPayload.lineItems as Array<{ unitPriceCents: number }>)[0].unitPriceCents).toBe(13500);

    // The cascade reached real tenant config.
    expect((await settingsRepo.findByTenant(tenantA.tenantId))!.laborRateCentsPerHour).toBe(13500);

    // T2 — the neighbour's divergent correction produced ITS lesson and ITS
    // rate; neither tenant can see the other's lesson.
    const lessonsB = await lessonRepo.findBySourceProposal(tenantB.tenantId, resB.proposalId);
    expect(lessonsB).toHaveLength(1);
    expect(lessonsB[0].payload).toEqual({ kind: 'labor_rate_changed', beforeCents: 11500, afterCents: 9900 });
    expect((await settingsRepo.findByTenant(tenantB.tenantId))!.laborRateCentsPerHour).toBe(9900);
    expect(await lessonRepo.findBySourceProposal(tenantB.tenantId, resA.proposalId)).toEqual([]);
    expect(await lessonRepo.findBySourceProposal(tenantA.tenantId, resB.proposalId)).toEqual([]);
  });

  it("9.9: the owner reverses the lesson a real executed correction recorded (and the labor rate it cascaded) through undoProposal's explicit lessons scope — the approval undo still refuses the executed proposal, the estimate stays, and a neighbour tenant (T2) keeps its lesson and rate", async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const { jobId: jobA, customerId: customerA } = await seedJob(pool, tenantA.tenantId, tenantA.userId);
    const { jobId: jobB, customerId: customerB } = await seedJob(pool, tenantB.tenantId, tenantB.userId);

    const resA = await driveRealPipeline(tenantA.tenantId, tenantA.userId, jobA, customerA, 13500);
    const resB = await driveRealPipeline(tenantB.tenantId, tenantB.userId, jobB, customerB, 9900);

    // The REAL lesson from the real pipeline (9.8) — nothing seeded.
    const lessonsA = await lessonRepo.findBySourceProposal(tenantA.tenantId, resA.proposalId);
    expect(lessonsA).toHaveLength(1);
    const lessonA = lessonsA[0];
    expect((await settingsRepo.findByTenant(tenantA.tenantId))!.laborRateCentsPerHour).toBe(13500);

    const correctionLoop = { lessonRepo, ports };

    // Refusal kept: the approval undo (no scope — what the post-approve undo
    // toast sends) still refuses an executed proposal and touches nothing.
    await expect(
      undoProposal(proposalRepo, tenantA.tenantId, resA.proposalId, tenantA.userId, 'owner', auditRepo, correctionLoop),
    ).rejects.toThrow(ValidationError);
    expect((await lessonRepo.findById(tenantA.tenantId, lessonA.id))!.status).toBe('applied');
    expect((await settingsRepo.findByTenant(tenantA.tenantId))!.laborRateCentsPerHour).toBe(13500);

    // The lesson undo.
    const result = await undoProposal(
      proposalRepo,
      tenantA.tenantId,
      resA.proposalId,
      tenantA.userId,
      'owner',
      auditRepo,
      correctionLoop,
      { scope: 'lessons' },
    );
    // The proposal stays executed (terminal) and its estimate stays.
    expect(result.status).toBe('executed');
    expect((await proposalRepo.findById(tenantA.tenantId, resA.proposalId))!.status).toBe('executed');
    expect((await estimateRepo.findById(tenantA.tenantId, resA.estimateId))!.lineItems[0].unitPriceCents).toBe(13500);

    // The lesson is reverted and the cascaded labor rate is restored.
    expect((await lessonRepo.findById(tenantA.tenantId, lessonA.id))!.status).toBe('reverted');
    expect((await settingsRepo.findByTenant(tenantA.tenantId))!.laborRateCentsPerHour).toBe(11500);
    const revertAuditsFor = async () =>
      (await auditRepo.findByEntity(tenantA.tenantId, 'correction_lesson', lessonA.id)).filter(
        (e) => e.eventType === 'correction_lesson.reverted',
      );
    expect(await revertAuditsFor()).toHaveLength(1);

    // Idempotent: a second lesson undo re-reverses nothing and re-audits nothing.
    await undoProposal(proposalRepo, tenantA.tenantId, resA.proposalId, tenantA.userId, 'owner', auditRepo, correctionLoop, {
      scope: 'lessons',
    });
    expect((await settingsRepo.findByTenant(tenantA.tenantId))!.laborRateCentsPerHour).toBe(11500);
    expect(await revertAuditsFor()).toHaveLength(1);

    // T2 — the neighbour's lesson and rate are untouched, and tenant A cannot
    // reach tenant B's proposal through the lesson undo.
    const lessonsB = await lessonRepo.findBySourceProposal(tenantB.tenantId, resB.proposalId);
    expect(lessonsB).toHaveLength(1);
    await expect(
      undoProposal(proposalRepo, tenantA.tenantId, resB.proposalId, tenantA.userId, 'owner', auditRepo, correctionLoop, {
        scope: 'lessons',
      }),
    ).rejects.toThrow();
    expect((await lessonRepo.findById(tenantB.tenantId, lessonsB[0].id))!.status).toBe('applied');
    expect((await settingsRepo.findByTenant(tenantB.tenantId))!.laborRateCentsPerHour).toBe(9900);
  });
});

// PI-3 — the lesson cascade rewrote the tenant price book and labor rate for
// WHOEVER approved the edited card: a dispatcher (proposals:edit +
// proposals:approve, no settings:update) changed a catalog-bound line's price
// on PUT /api/proposals/:id, approved it, and the execution's lesson wrote
// catalog_items.unit_price_cents and the tenant labor rate — authority the
// catalog routes and the lesson undo both reserve for settings:update. The
// audit then named the DRAFTER with role 'owner'.
describe('PI-3 — a correction cascades into tenant config only under an approver who holds settings:update', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let catalogRepo: PgCatalogItemRepository;
  let lessonRepo: PgCorrectionLessonRepository;
  let auditRepo: PgAuditRepository;
  let ports: ConfigPorts;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    lessonRepo = new PgCorrectionLessonRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    ports = createPgConfigPorts({ settingsRepo, catalogRepo });
  });

  const line = (id: string, category: string, cents: number, catalogItemId?: string) => ({
    id,
    description: category === 'labor' ? 'Standard Labor' : 'Smoke Detector',
    category,
    quantity: 1,
    unitPriceCents: cents,
    totalCents: cents,
    sortOrder: id === 'l1' ? 0 : 1,
    taxable: true,
    ...(catalogItemId ? { catalogItemId } : {}),
  });

  /** AI draft at the tenant's prices → edited by `editor` → approved by `approver` → executed. */
  async function editApproveExecute(role: Role) {
    const tenant = await createTestTenant(pool);
    const { jobId, customerId } = await seedJob(pool, tenant.tenantId, tenant.userId);
    await settingsRepo.create({
      id: uuidv4(),
      tenantId: tenant.tenantId,
      businessName: 'Price Book Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await settingsRepo.update(tenant.tenantId, { laborRateCentsPerHour: 11500 });
    const detector = await catalogRepo.create(
      createCatalogItem({
        tenantId: tenant.tenantId,
        name: 'Smoke Detector',
        category: 'Materials',
        unit: 'each',
        unitPriceCents: 4500,
      }),
    );
    // The approver: the tenant owner (seeded by createTestTenant) or a
    // dispatcher member of the same tenant.
    const approverId = role === 'owner' ? tenant.userId : uuidv4();
    if (role !== 'owner') {
      await pool.query(
        `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
        [approverId, tenant.tenantId, approverId, `${role}-${approverId.slice(0, 6)}@example.com`, role],
      );
    }

    const draft = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'draft_estimate',
      payload: {
        jobId,
        customerId,
        lineItems: [line('l1', 'labor', 11500), line('p1', 'material', 4500, detector.id)],
      },
      summary: 'Estimate for job',
      // Drafted by someone other than the approver, so attribution is tested.
      createdBy: 'ai-drafter',
    });
    await proposalRepo.create(draft);

    // PUT /api/proposals/:id (proposals:edit, which a dispatcher holds).
    await editProposal(
      proposalRepo,
      tenant.tenantId,
      draft.id,
      approverId,
      role,
      { lineItems: [line('l1', 'labor', 13500), line('p1', 'material', 5200, detector.id)] },
      auditRepo,
    );
    // POST /api/proposals/:id/approve.
    await approveProposal(proposalRepo, tenant.tenantId, draft.id, approverId, role, auditRepo);
    await proposalRepo.updateStatus(tenant.tenantId, draft.id, 'approved', {
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    });

    const registry = createExecutionHandlerRegistry({ estimateRepo, settingsRepo, auditRepo });
    const executor = new ProposalExecutor(registry, proposalRepo, new IdempotencyGuard(executionRepo, proposalRepo), auditRepo, {
      executionRepo,
      onExecuted: async (event) => {
        if (event.status !== 'succeeded') return;
        await recordCorrectionLessonsOnExecution(
          { tenantId: event.tenantId, proposalId: event.proposalId },
          { proposalRepo, proposalExecutionRepo: executionRepo, settingsRepo, lessonRepo, catalogRepo, ports, auditRepo },
        );
      },
    });
    // Exactly what the execution sweep passes (workers/execution-worker.ts).
    const stamped = (await proposalRepo.findById(tenant.tenantId, draft.id))!;
    const { result } = await executor.execute(stamped, {
      tenantId: tenant.tenantId,
      executedBy: stamped.executedBy ?? stamped.createdBy,
      ...(stamped.executedByRole ? { executedByRole: stamped.executedByRole } : {}),
    });
    expect(result.success).toBe(true);

    const { rows: price } = await pool.query(
      `SELECT unit_price_cents FROM catalog_items WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, detector.id],
    );
    const { rows: applied } = await pool.query(
      `SELECT actor_id, actor_role, metadata->>'lessonType' AS lesson_type FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'correction_lesson.applied'
          AND metadata->>'sourceProposalId' = $2`,
      [tenant.tenantId, draft.id],
    );
    return {
      tenant,
      approverId,
      proposalId: draft.id,
      estimateId: result.resultEntityId!,
      catalogPriceCents: Number(price[0].unit_price_cents),
      laborRateCents: (await settingsRepo.findByTenant(tenant.tenantId))!.laborRateCentsPerHour,
      lessons: await lessonRepo.findBySourceProposal(tenant.tenantId, draft.id),
      applied,
    };
  }

  it('a DISPATCHER-approved correction leaves the catalog price and the labor rate unchanged, and records no lesson', async () => {
    const res = await editApproveExecute('dispatcher');

    // The document itself still executes at the corrected prices.
    const estimate = await estimateRepo.findById(res.tenant.tenantId, res.estimateId);
    expect(estimate!.lineItems.map((li) => li.unitPriceCents)).toEqual([13500, 5200]);

    expect(res.catalogPriceCents).toBe(4500);
    expect(res.laborRateCents).toBe(11500);
    expect(res.lessons).toEqual([]);
    expect(res.applied).toEqual([]);
  });

  it('an OWNER-approved correction applies both lessons, audited with the owner id and actor_role owner', async () => {
    const res = await editApproveExecute('owner');

    expect(res.catalogPriceCents).toBe(5200);
    expect(res.laborRateCents).toBe(13500);
    expect(res.lessons.map((l) => l.lessonType).sort()).toEqual(['labor_rate_changed', 'part_price_changed']);
    expect(res.lessons.every((l) => l.ownerId === res.approverId)).toBe(true);
    expect(res.applied).toHaveLength(2);
    for (const row of res.applied) {
      expect(row.actor_id).toBe(res.approverId);
      expect(row.actor_role).toBe('owner');
    }
  });
});
