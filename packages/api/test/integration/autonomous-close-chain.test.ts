/**
 * QUALITY-2026-07-12 WS2 (D-019) — owner-approval close chain against REAL
 * Postgres. Proves the new human-authority flow end to end:
 *   - migration 247 (`tenant_settings.autonomous_close_enabled` /
 *     `autonomous_close_max_cents`) through the PgSettingsRepository read mapping;
 *   - gates pass → `queueCloseFallbackChain` stages a THREE-member DRAFT chain
 *     (draft_estimate → send_estimate → create_booking[held slot]) with
 *     `proposals.chain_id` written via the generic update — nothing approved,
 *     no `approvedAt`;
 *   - owner one-tap approve (`approveChainSet`) approves the capture-class head
 *     + booking with `approvedAt ≈ now` (NEVER backdated) — the comms send
 *     follows separately;
 *   - the D-009 undo window is HONORED: the production executor refuses a
 *     just-approved member (`UNDO_WINDOW_OPEN`) and runs it only once the window
 *     has elapsed — the estimate row is created, `send_estimate` resolves the
 *     chain `$ref` to the real estimateId and dispatches, and the held booking
 *     is confirmed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { NoopEstimateDeliveryProvider } from '../../src/proposals/execution/voice-extended-handlers';
import {
  queueCloseFallbackChain,
  AUTONOMOUS_CLOSE_ACTOR,
} from '../../src/proposals/autonomous-close-execution';
import { evaluateAutonomousCloseLane } from '../../src/proposals/autonomous-close-lane';
import { approveChainSet, approveProposal } from '../../src/proposals/actions';
import { isInUndoWindow } from '../../src/proposals/lifecycle';
import { placeAppointmentHold } from '../../src/ai/scheduling/place-hold';
import { createProposal, type Proposal } from '../../src/proposals/proposal';
import type { ExecutionContext } from '../../src/proposals/execution/handlers';

const CALLER_PHONE = '+15125550100';
const OWNER = 'owner-user';

describe('Integration — D-019 owner-approval close chain (real Postgres)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let appointmentRepo: PgAppointmentRepository;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let executor: ProposalExecutor;
  let estimateDelivery: NoopEstimateDeliveryProvider;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    estimateDelivery = new NoopEstimateDeliveryProvider();

    tenant = await createTestTenant(pool);

    // Migration 247 columns pinned at INSERT time.
    await pool.query(
      `INSERT INTO tenant_settings
         (id, tenant_id, business_name, timezone, autonomous_close_enabled, autonomous_close_max_cents,
          autonomous_booking_enabled, autonomous_booking_threshold)
       VALUES (gen_random_uuid(), $1, 'Close Co', 'America/Chicago', TRUE, 500000, TRUE, 0.95)`,
      [tenant.tenantId],
    );

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada Lovelace',
      primaryPhone: CALLER_PHONE,
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

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
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-CLOSE-1',
      summary: 'Water heater replacement',
      status: 'new',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const handlers = createExecutionHandlerRegistry({
      proposalRepo,
      appointmentRepo,
      jobRepo,
      locationRepo,
      customerRepo,
      estimateRepo,
      settingsRepo,
      auditRepo,
      estimateDeliveryProvider: estimateDelivery,
    });
    executor = new ProposalExecutor(
      handlers,
      proposalRepo,
      new IdempotencyGuard(new PgProposalExecutionRepository(pool), proposalRepo),
      auditRepo,
      { executionRepo: new PgProposalExecutionRepository(pool) },
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** The live drafted estimate proposal, as the WS5 voice path persists it. */
  async function seedDraftEstimateProposal(): Promise<Proposal> {
    const draft = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'draft_estimate',
      payload: {
        intent: 'draft_estimate',
        entities: { lineItemDescriptions: ['water heater replacement'] },
        lineItems: [
          {
            description: 'Water Heater Replacement',
            quantity: 1,
            unitPrice: 185000,
            pricingSource: 'catalog',
            needsPricing: false,
          },
        ],
        _meta: { overallConfidence: 'high' },
      },
      summary: 'Voice intent: draft_estimate',
      confidenceScore: 0.97,
      createdBy: customerId,
      sourceContext: { source: 'calling-agent', channel: 'telephony' },
    });
    return proposalRepo.create(draft);
  }

  it('gates pass → drafts staged → owner one-tap approve → undo window honored → booking confirmed', async () => {
    // 1. Hold — the shared place-hold helper against real appointments columns.
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const hold = await placeAppointmentHold(
      { appointmentRepo },
      {
        tenantId: tenant.tenantId,
        jobId,
        customerId,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 60 * 60 * 1000),
        timezone: 'America/Chicago',
        createdBy: AUTONOMOUS_CLOSE_ACTOR,
        idempotencyKey: 'close-int:vs-int-1',
      },
    );
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;

    // 2. Lane (real settings via the PgSettingsRepository read mapping) → eligible.
    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    expect(settings!.autonomousCloseEnabled).toBe(true);
    const evaluation = evaluateAutonomousCloseLane({
      platformDisabled: false,
      tenantOptedIn: settings!.autonomousCloseEnabled === true,
      closeCapCents: settings!.autonomousCloseMaxCents,
      groundedClean: true,
      quoteTotalCents: 185000,
      strictConfirmed: true,
      smsConsentCaptured: true,
      schedulingComplete: true,
      holdPlaced: true,
      holdExpiryAt: hold.holdExpiryAt,
      now: new Date(),
      booking: {
        platformDisabled: false,
        settings: {
          enabled: settings!.autonomousBookingEnabled === true,
          threshold: settings!.autonomousBookingThreshold,
        },
        proposalType: 'create_booking',
        inboundReceptionistSource: true,
        confidenceScore: 0.97,
        payload: { appointmentId: hold.appointmentId },
        pendingReferenceCount: 0,
        customerId,
        holdPlaced: true,
        holdExpiryAt: hold.holdExpiryAt,
        now: new Date(),
        slotWithinBusinessHours: true,
      },
      flags: {},
    });
    expect(evaluation.eligible).toBe(true);

    // 3. Stage the owner-approval chain (drafts only) — nothing approved.
    const draft = await seedDraftEstimateProposal();
    const smsBodies: string[] = [];
    const staged = await queueCloseFallbackChain(
      {
        proposalRepo,
        auditRepo,
        routing: {
          auditRepo,
          sendSms: async (_to, body) => { smsBodies.push(body); },
          secret: 'close-int-secret',
          buildApproveUrl: (t) => `https://x/approve?token=${t}`,
          ownerPhoneResolver: async () => '+15125550999',
        },
      },
      {
        tenantId: tenant.tenantId,
        draftEstimateProposalId: draft.id,
        customerId,
        callerPhone: CALLER_PHONE,
        sessionId: 'vs-int-1',
        evaluation,
        booking: {
          appointmentId: hold.appointmentId,
          holdExpiryAt: hold.holdExpiryAt,
          summary: 'Booked (integration)',
        },
      },
    );
    expect(staged).toEqual({ queued: true, smsSent: true });
    expect(smsBodies[0]).toContain('3 linked actions:');

    const head = (await proposalRepo.findById(tenant.tenantId, draft.id))!;
    expect(head.chainId).toBeDefined();
    const members = await proposalRepo.findByChain(tenant.tenantId, head.chainId!);
    expect(members).toHaveLength(3);
    // Nothing is approved; no approvedAt anywhere (no system approval, no backdating).
    for (const m of members) {
      expect(m.status).toBe('draft');
      expect(m.approvedAt).toBeUndefined();
    }
    const booking = members.find((m) => m.proposalType === 'create_booking')!;
    expect(booking.payload.appointmentId).toBe(hold.appointmentId);

    // 4. Owner one-tap approve → head + booking approved with approvedAt ≈ now.
    const before = Date.now();
    const approvedSet = await approveChainSet(
      proposalRepo, tenant.tenantId, head.id, OWNER, 'owner', auditRepo, 'one_tap',
    );
    const after = Date.now();
    const approvedTypes = approvedSet.approved.map((p) => p.proposalType).sort();
    expect(approvedTypes).toEqual(['create_booking', 'draft_estimate']);
    for (const p of approvedSet.approved) {
      expect(p.approvedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(p.approvedAt!.getTime()).toBeLessThanOrEqual(after + 1000);
      expect(isInUndoWindow(p, Date.now())).toBe(true);
    }

    // 5. Undo window HONORED — the production executor refuses a just-approved member.
    const ctx: ExecutionContext = { tenantId: tenant.tenantId, executedBy: OWNER };
    const freshDraft = (await proposalRepo.findById(tenant.tenantId, draft.id))!;
    await expect(executor.execute(freshDraft, ctx)).rejects.toMatchObject({
      code: 'UNDO_WINDOW_OPEN',
    });

    // 6. Simulate the undo window elapsing, then execute in chain order.
    await pool.query(
      `UPDATE proposals SET approved_at = NOW() - INTERVAL '10 seconds'
       WHERE tenant_id = $1 AND status = 'approved'`,
      [tenant.tenantId],
    );
    // Also approve the comms send member (the owner's separate approval), and
    // backdate it, so we can prove the chain $ref resolves end to end.
    const sendMember = members.find((m) => m.proposalType === 'send_estimate')!;
    await approveProposal(proposalRepo, tenant.tenantId, sendMember.id, OWNER, 'owner', auditRepo, 'ui');
    await pool.query(
      `UPDATE proposals SET approved_at = NOW() - INTERVAL '10 seconds' WHERE id = $1`,
      [sendMember.id],
    );

    // draft_estimate → create the estimate row.
    const execDraft = (await proposalRepo.findById(tenant.tenantId, draft.id))!;
    const draftOut = await executor.execute(execDraft, ctx);
    expect(draftOut.result.success).toBe(true);
    const estimateId = (await proposalRepo.findById(tenant.tenantId, draft.id))!.resultEntityId!;
    const estimate = await estimateRepo.findById(tenant.tenantId, estimateId);
    expect(estimate!.totals.totalCents).toBe(185000);

    // send_estimate → chain resolution swaps in the real estimateId + dispatches.
    const execSend = (await proposalRepo.findById(tenant.tenantId, sendMember.id))!;
    const sendOut = await executor.execute(execSend, ctx);
    expect(sendOut.result.success).toBe(true);
    expect(estimateDelivery.lastDispatch).toMatchObject({
      tenantId: tenant.tenantId,
      estimateId,
      channel: 'sms',
      recipient: CALLER_PHONE,
    });

    // create_booking → the held appointment is confirmed.
    const execBooking = (await proposalRepo.findById(tenant.tenantId, booking.id))!;
    const bookingOut = await executor.execute(execBooking, ctx);
    expect(bookingOut.result.success).toBe(true);
    const appt = await appointmentRepo.findById(tenant.tenantId, hold.appointmentId);
    expect(appt!.holdPendingApproval).toBe(false);
  });

  it('tenant not opted in → two-member owner chain (no booking), nothing approved', async () => {
    const draft = await seedDraftEstimateProposal();
    const smsBodies: string[] = [];
    const result = await queueCloseFallbackChain(
      {
        proposalRepo,
        auditRepo,
        routing: {
          auditRepo,
          sendSms: async (_to, body) => { smsBodies.push(body); },
          secret: 'close-int-secret',
          buildApproveUrl: (t) => `https://x/approve?token=${t}`,
          ownerPhoneResolver: async () => '+15125550999',
        },
      },
      {
        tenantId: tenant.tenantId,
        draftEstimateProposalId: draft.id,
        customerId,
        callerPhone: CALLER_PHONE,
        sessionId: 'vs-int-2',
        evaluation: { eligible: false, reason: 'tenant_not_opted_in' },
      },
    );
    expect(result).toEqual({ queued: true, smsSent: true });
    expect(smsBodies).toHaveLength(1);
    expect(smsBodies[0]).toContain('2 linked actions:');

    const head = (await proposalRepo.findById(tenant.tenantId, draft.id))!;
    const siblings = await proposalRepo.findByChain(tenant.tenantId, head.chainId!);
    expect(siblings).toHaveLength(2);
    expect(siblings.find((p) => p.proposalType === 'create_booking')).toBeUndefined();
    const send = siblings.find((p) => p.proposalType === 'send_estimate')!;
    expect(send.status).toBe('draft');
    expect(send.payload.estimateId).toBe('$ref:chain[0].estimateId');
    expect(siblings.every((p) => p.status === 'draft')).toBe(true);

    // Idempotent: a second attempt does not re-chain or re-text.
    const again = await queueCloseFallbackChain(
      { proposalRepo, auditRepo },
      {
        tenantId: tenant.tenantId,
        draftEstimateProposalId: draft.id,
        customerId,
        callerPhone: CALLER_PHONE,
        sessionId: 'vs-int-2',
        evaluation: { eligible: false, reason: 'tenant_not_opted_in' },
      },
    );
    expect(again).toEqual({ queued: false, smsSent: false });
  });
});
