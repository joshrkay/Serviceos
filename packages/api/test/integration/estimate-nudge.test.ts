/**
 * Docker-gated integration test for T4-F01's estimate-nudge claim-before-send
 * gate — proves dispatchEstimateNudge's interplay with real Postgres columns
 * (send_claims + estimates.reminder_count/last_reminder_at), not just the
 * mocked-Pool unit test (test/estimates/estimate-nudge.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import { createEstimate, type Estimate } from '../../src/estimates/estimate';
import {
  dispatchEstimateNudge,
  EstimateNudgeAlreadyClaimedError,
} from '../../src/estimates/estimate-nudge';
import type { SendService } from '../../src/notifications/send-service';
import { missingFieldsFor, type Proposal } from '../../src/proposals/proposal';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { approveProposal } from '../../src/proposals/actions';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { SendEstimateNudgeTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';

describe('dispatchEstimateNudge (integration) — claim-before-send against real Postgres', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Test',
      lastName: 'Customer',
      displayName: 'Test Customer',
      preferredChannel: 'phone',
      smsConsent: true,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-NUDGE-1',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedSentEstimate(estimateNumber: string): Promise<Estimate> {
    const items: LineItem[] = [buildLineItem('li-1', 'Service call', 1, 15000, 0, true, 'labor')];
    const est = await createEstimate(
      { tenantId: tenant.tenantId, jobId, estimateNumber, lineItems: items, createdBy: tenant.userId },
      estimateRepo,
    );
    return (await estimateRepo.update(tenant.tenantId, est.id, {
      status: 'sent',
      sentAt: new Date('2026-06-01T00:00:00Z'),
    }))!;
  }

  function fakeSendService(): { sendService: Pick<SendService, 'sendEstimate'>; sendEstimate: ReturnType<typeof vi.fn> } {
    const sendEstimate = vi.fn().mockResolvedValue({
      estimateId: 'x',
      viewUrl: 'https://x/e/tok',
      viewToken: 'tok',
      channelsSent: [],
    });
    return { sendService: { sendEstimate }, sendEstimate };
  }

  it('happy path: sends once and persists reminder_count/last_reminder_at on the real row', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-1');
    const { sendService, sendEstimate } = fakeSendService();
    const auditRepo = new InMemoryAuditRepository();
    const asOf = new Date('2026-06-05T00:00:00Z');

    await dispatchEstimateNudge(
      { estimateRepo, sendService, auditRepo, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf, actorId: 'test' },
    );

    expect(sendEstimate).toHaveBeenCalledTimes(1);
    const updated = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(updated!.reminderCount).toBe(1);
    expect(updated!.lastReminderAt).toEqual(asOf);

    const claimRow = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v1:1`],
    );
    expect(claimRow.rows[0].status).toBe('sent');
  });

  it('reclaims a stale claim for the same occurrence (crash between claim and send)', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-2');
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, $2, 'claimed', NOW() - INTERVAL '20 minutes')`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v1:1`],
    );
    const { sendService, sendEstimate } = fakeSendService();

    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );

    expect(sendEstimate).toHaveBeenCalledTimes(1);
    const updated = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(updated!.reminderCount).toBe(1);
  });

  it('Codex P2 (PR #705) — a "sent" claim for the same occurrence is RECONCILED (no resend, no throw, reminder_count finished) — crash between send and mark', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-3');
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at, sent_at)
       VALUES ($1, $2, 'sent', NOW(), NOW())`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v1:1`],
    );
    const { sendService, sendEstimate } = fakeSendService();
    const asOf = new Date('2026-06-07T00:00:00Z');

    // Must NOT throw — the send already happened; throwing would freeze the
    // cadence. It reconciles the missing reminder_count bookkeeping instead.
    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf, actorId: 'test' },
    );

    expect(sendEstimate).not.toHaveBeenCalled();
    const updated = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(updated!.reminderCount).toBe(1);
    expect(updated!.lastReminderAt).toEqual(asOf);
  });

  it('two concurrent dispatchEstimateNudge calls for the same estimate: exactly one send, cadence advances once', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-4');
    const { sendService, sendEstimate } = fakeSendService();

    const attempt = () =>
      dispatchEstimateNudge(
        { estimateRepo, sendService, pool },
        { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
      );

    const results = await Promise.allSettled([attempt(), attempt()]);

    // The invariant that matters: the provider is called exactly once (no
    // double-send), and reminderCount ends at exactly 1. The loser either
    // rejects with EstimateNudgeAlreadyClaimedError (it observed the winner's
    // in-flight 'claimed'/'sending' claim) OR reconciles idempotently (it
    // observed the winner's completed 'sent' tombstone) — both are correct and
    // which one happens is a real-DB timing detail, so we don't pin it.
    expect(sendEstimate).toHaveBeenCalledTimes(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeLessThanOrEqual(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(EstimateNudgeAlreadyClaimedError);
    }
    const updated = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(updated!.reminderCount).toBe(1);
  });

  it('repeatability: a second nudge (occurrence 2) after the first completes is a fresh, independent claim', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-5');
    const { sendService, sendEstimate } = fakeSendService();

    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );
    const afterFirst = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(afterFirst!.reminderCount).toBe(1);

    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate: afterFirst!, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );

    expect(sendEstimate).toHaveBeenCalledTimes(2);
    const afterSecond = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(afterSecond!.reminderCount).toBe(2);
  });

  it('Codex P1 (PR #705): a revised estimate (version bump + reminderCount reset) is re-notified — occurrence 1 does not collide with the prior revision\'s tombstone', async () => {
    const estimate = await seedSentEstimate('EST-NUDGE-REV');
    const { sendService, sendEstimate } = fakeSendService();

    // Version 1, reminder #1 — claims + tombstones estimate_nudge:{id}:v1:1.
    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );
    const v1Claim = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v1:1`],
    );
    expect(v1Claim.rows[0].status).toBe('sent');

    // reviseEstimate's effect: bump version -> 2 and reset reminderCount -> 0
    // so the revised pricing is re-notified. The next nudge recomputes
    // occurrence 1; without the version in the key it would hit the v1:1
    // tombstone and never re-send.
    const revised = (await estimateRepo.update(tenant.tenantId, estimate.id, {
      version: 2,
      reminderCount: 0,
    }))!;

    await dispatchEstimateNudge(
      { estimateRepo, sendService, pool },
      { tenantId: tenant.tenantId, estimate: revised, channel: 'sms', asOf: new Date(), actorId: 'test' },
    );

    // The revised estimate really was re-sent, under a fresh v2:1 claim.
    expect(sendEstimate).toHaveBeenCalledTimes(2);
    const v2Claim = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenant.tenantId, `estimate_nudge:${estimate.id}:v2:1`],
    );
    expect(v2Claim.rows[0].status).toBe('sent');
    const afterRevise = await estimateRepo.findById(tenant.tenantId, estimate.id);
    expect(afterRevise!.reminderCount).toBe(1);
  });
});

/**
 * B8.10 (rivet-voice-19) — "Nudge the Khan estimate" against REAL Postgres,
 * end to end.
 *
 * Pre-B8.10, SendEstimateNudgeTaskHandler hard-coded
 * `missing = ['estimateId']` unconditionally, so a spoken nudge could never
 * complete. This certifies the full chain against real rows: the REAL
 * SendEstimateNudgeTaskHandler.handle() (the same handler
 * handler-registry.ts:234 wires for both the voice worker and the assistant
 * chat route) resolves "Khan" to the seeded, unique, nudgeable ("sent")
 * estimate → approveProposal (proposals/actions.ts) → the PRODUCTION
 * execution registry (createExecutionHandlerRegistry, handlers.ts:1139) +
 * ProposalExecutor → a real message_dispatches row + `estimate.reminder_sent`
 * audit event (dispatchEstimateNudge, estimate-nudge.ts) + a
 * `proposal.executed` audit event (ProposalExecutor, WS11).
 *
 * Also proves the 48h cooldown (ESTIMATE_NUDGE_COOLDOWN_MS,
 * handlers.ts:1008) holds under a VOICE-approved retry: a second
 * voice-drafted, voice-approved nudge for the same estimate inside the
 * window sends nothing (no second dispatch row, sendEstimate not
 * re-invoked) and records the suppressed outcome on the proposal itself
 * (`execution_failed` + `executionError`), not a silent no-op — plus its own
 * `proposal.execution_failed` audit event.
 *
 * The delivery provider is faked (SendService's own customer/settings/
 * template-rendering internals are already covered by
 * test/notifications/send-service.test.ts) — but the dispatch row it writes
 * is a REAL PgDispatchRepository insert, so the "dispatch row + audit event"
 * assertions are against genuine Postgres rows, not an in-memory stand-in.
 *
 * Runs only under `npm run test:integration`.
 */
describe('Postgres integration — voice send_estimate_nudge ("Nudge the Khan estimate") → approve → execute → dispatch + audit; 48h cooldown holds under voice', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let auditRepo: PgAuditRepository;
  let dispatchRepo: PgDispatchRepository;
  let proposalRepo: PgProposalRepository;
  let executor: ProposalExecutor;
  let tenant: { tenantId: string; userId: string };
  let estimate: Estimate;
  let firstProposalId: string;
  let sendEstimate: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Khan',
      lastName: 'Household',
      displayName: 'Khan Household',
      preferredChannel: 'phone',
      smsConsent: true,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Khan Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-NUDGE-VOICE-1',
      summary: 'Khan — water heater',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Seed the UNIQUE, verified, NUDGEABLE ("sent") estimate B8.10's
    // resolution ladder is meant to find. customerMessage carries "Khan" so
    // the SAME estimate_number/customer_message ILIKE search
    // candidatesForReference (and this handler) already use resolves it —
    // exactly one match, in a nudgeable status.
    const items: LineItem[] = [buildLineItem('li-1', 'Service call', 1, 45000, 0, true, 'labor')];
    const created = await createEstimate(
      {
        tenantId: tenant.tenantId,
        jobId,
        estimateNumber: 'EST-NUDGE-VOICE-1',
        lineItems: items,
        customerMessage: 'Khan residence — water heater estimate',
        createdBy: tenant.userId,
      },
      estimateRepo,
    );
    estimate = (await estimateRepo.update(tenant.tenantId, created.id, {
      status: 'sent',
      sentAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago — well outside any cooldown at test start
    }))!;

    // sendEstimate is faked (no real delivery provider), but it writes a
    // REAL message_dispatches row via PgDispatchRepository so the "dispatch
    // row" assertions below are against genuine Postgres rows.
    sendEstimate = vi.fn(async (input: Parameters<SendService['sendEstimate']>[0]) => {
      await dispatchRepo.create({
        tenantId: input.tenantId,
        entityType: 'estimate',
        entityId: input.estimateId,
        channel: 'sms',
        recipient: 'khan@example.test',
        provider: 'test',
        status: 'sent',
      });
      return {
        estimateId: input.estimateId,
        viewUrl: 'https://example.test/e/tok',
        viewToken: 'tok',
        channelsSent: [],
      };
    });
    // `sendEstimate` is declared at describe scope (so later `it`s can assert
    // call counts) with the widened `ReturnType<typeof vi.fn>` type, which
    // loses the specific `SendService['sendEstimate']` call signature TS
    // otherwise infers at the `vi.fn(async (input) => ...)` call site — cast
    // through `unknown` rather than re-widening the mock itself.
    const sendService = { sendEstimate } as unknown as Pick<SendService, 'sendEstimate'>;

    // Production registry — proves createExecutionHandlerRegistry wires
    // SendEstimateNudgeExecutionHandler exactly the way app.ts does,
    // including the T4-F01 claim-before-send pool.
    const registry = createExecutionHandlerRegistry({
      estimateRepo,
      sendService,
      dispatchRepo,
      auditRepo,
      pool,
    });
    const executionRepo = new PgProposalExecutionRepository(pool);
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    // 1) Draft via the REAL SendEstimateNudgeTaskHandler for the fixture
    // sentence — "Khan" is all the classifier extracts
    // (existingEntities.customerName); the handler's own B8.10 resolution
    // ladder (estimateRepo search) resolves the unique, verified, nudgeable
    // match — NOT a hand-built payload.
    const handler = new SendEstimateNudgeTaskHandler({ estimateRepo: new PgEstimateRepository(pool) });
    const taskContext: TaskContext = {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Nudge the Khan estimate',
      existingEntities: { customerName: 'Khan' },
    };
    const { proposal: draftedProposal } = await handler.handle(taskContext);

    expect(draftedProposal.proposalType).toBe('send_estimate_nudge');
    expect(draftedProposal.payload.estimateId).toBe(estimate.id);
    // Resolved + verified + nudgeable ⇒ nothing gates the proposal for review.
    expect(missingFieldsFor(draftedProposal)).toEqual([]);
    // Comms-class — never auto-approves, a human always confirms the resend.
    expect(draftedProposal.status).toBe('draft');

    await proposalRepo.create(draftedProposal);

    // 2) Approve via the PRODUCTION approveProposal helper (proposals/actions.ts).
    const approved: Proposal = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      draftedProposal.id,
      tenant.userId,
      'owner',
      auditRepo,
      'ui',
    );
    expect(approved.status).toBe('approved');

    // Backdate past the 5-second undo window so execution isn't refused.
    const backdated: Proposal = {
      ...approved,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };

    // 3) Execute via the registered execution handler.
    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(backdated, context);
    expect(result.success).toBe(true);
    firstProposalId = draftedProposal.id;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('dispatches a real message_dispatches row for the estimate', async () => {
    const dispatches = await dispatchRepo.findByEntity(tenant.tenantId, 'estimate', estimate.id);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].status).toBe('sent');
    expect(dispatches[0].entityType).toBe('estimate');
  });

  it('emits a proposal.executed audit event with actor attribution', async () => {
    const { rows } = await pool.query(
      `SELECT event_type, actor_id FROM audit_events
        WHERE entity_type = 'proposal' AND entity_id = $1 AND event_type = 'proposal.executed'`,
      [firstProposalId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(tenant.userId);
  });

  it('also emits the estimate.reminder_sent audit event (dispatchEstimateNudge bookkeeping)', async () => {
    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'estimate' AND entity_id = $1 AND event_type = 'estimate.reminder_sent'`,
      [estimate.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('48h cooldown holds under voice: a second voice-approved nudge inside the window sends nothing and records the suppressed outcome', async () => {
    // Draft AGAIN via the real handler for the same spoken reference — the
    // estimate's status is still 'sent' (nudging doesn't transition it), so
    // B8.10's resolution ladder resolves it ungated exactly as before.
    const handler = new SendEstimateNudgeTaskHandler({ estimateRepo: new PgEstimateRepository(pool) });
    const taskContext: TaskContext = {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Nudge the Khan estimate again',
      existingEntities: { customerName: 'Khan' },
    };
    const { proposal: secondDraft } = await handler.handle(taskContext);
    expect(missingFieldsFor(secondDraft)).toEqual([]);
    expect(secondDraft.payload.estimateId).toBe(estimate.id);
    await proposalRepo.create(secondDraft);

    const approved = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      secondDraft.id,
      tenant.userId,
      'owner',
      auditRepo,
      'ui',
    );
    const backdated: Proposal = {
      ...approved,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };

    const { result } = await executor.execute(backdated, context);

    // Suppressed, not silently dropped: execution itself reports failure...
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already sent|wait 48h/i);

    // ...and the PROPOSAL persistently records that suppressed outcome —
    // "sends nothing" must be provable after the fact, not just in the
    // in-memory return value.
    const persisted = await proposalRepo.findById(tenant.tenantId, secondDraft.id);
    expect(persisted!.status).toBe('execution_failed');
    expect(persisted!.executionError).toMatch(/already sent|wait 48h/i);

    // No second send, no second dispatch row — the cooldown genuinely held.
    expect(sendEstimate).toHaveBeenCalledTimes(1);
    const dispatches = await dispatchRepo.findByEntity(tenant.tenantId, 'estimate', estimate.id);
    expect(dispatches).toHaveLength(1);

    // The suppression itself is audited (WS11 — every execution outcome,
    // success or failure, writes its audit row in the same transaction).
    const { rows } = await pool.query(
      `SELECT event_type FROM audit_events
        WHERE entity_type = 'proposal' AND entity_id = $1 AND event_type = 'proposal.execution_failed'`,
      [secondDraft.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('cross-tenant negative: the dispatch row and the estimate are invisible to another tenant', async () => {
    const other = await createTestTenant(pool);
    const dispatches = await dispatchRepo.findByEntity(other.tenantId, 'estimate', estimate.id);
    expect(dispatches).toHaveLength(0);
    const found = await estimateRepo.findById(other.tenantId, estimate.id);
    expect(found).toBeNull();
  });
});
