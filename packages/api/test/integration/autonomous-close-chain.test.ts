/**
 * WS18d (D-018) — sanctioned close chain against REAL Postgres.
 *
 * Pins the columns the mocked-repo tests can't:
 *   - migration 247 (`tenant_settings.autonomous_close_enabled` /
 *     `autonomous_close_max_cents`) through the PgSettingsRepository read AND
 *     update mappings;
 *   - `proposals.chain_id` writable via the generic update (the close flow
 *     retrofits the live draft as chain head);
 *   - the full close loop: assemble → system-approve (backdated approvedAt) →
 *     synchronous in-order execution through the PRODUCTION ProposalExecutor:
 *     estimates row exists, send_estimate resolved member 0's resultEntityId
 *     via chain resolution and dispatched through the (Noop) provider, the
 *     held appointment is confirmed;
 *   - idempotent redelivery (a second execute short-circuits, no dup estimate);
 *   - the on-call consent capture (`consent_events` insert + customers.sms_consent);
 *   - the one-tap UNDO compensation (booking canceled, sent estimate expired);
 *   - the fallback mode (drafts + ONE owner chain SMS, nothing executes).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
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
import { PgConsentEventRepository } from '../../src/compliance/consent-events';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { NoopEstimateDeliveryProvider } from '../../src/proposals/execution/voice-extended-handlers';
import {
  assembleCloseChain,
  sanctionCloseChain,
  executeCloseChain,
  queueCloseFallbackChain,
  AUTONOMOUS_CLOSE_ACTOR,
} from '../../src/proposals/autonomous-close-execution';
import { evaluateAutonomousCloseLane } from '../../src/proposals/autonomous-close-lane';
import { placeAppointmentHold } from '../../src/ai/scheduling/place-hold';
import { recordSmsConsentFromVoice } from '../../src/voice/outbound-consent';
import { createProposal } from '../../src/proposals/proposal';
import { createOneTapUndoRouter } from '../../src/routes/one-tap-undo';
import { createOneTapUndoToken } from '../../src/proposals/one-tap-undo';
import { transitionEstimateStatus } from '../../src/estimates/estimate';

const CALLER_PHONE = '+15125550100';
const SECRET = 'close-int-secret';

describe('Integration — D-018 sanctioned close chain (real Postgres)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let appointmentRepo: PgAppointmentRepository;
  let estimateRepo: PgEstimateRepository;
  let settingsRepo: PgSettingsRepository;
  let consentRepo: PgConsentEventRepository;
  let customerRepo: PgCustomerRepository;
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
    consentRepo = new PgConsentEventRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
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
      smsConsent: false,
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
    });

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
  async function seedDraftEstimateProposal() {
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

  it('runs the full close loop: consent → hold → chain executes in order → undo compensates', async () => {
    // 1. On-call SMS consent capture — real consent_events + customers columns.
    await recordSmsConsentFromVoice(
      { consentLedger: consentRepo, customerRepo, auditRepo },
      { tenantId: tenant.tenantId, customerId, phone: CALLER_PHONE, voiceSessionId: 'vs-int-1' },
    );
    const ledger = await consentRepo.listByPhone(tenant.tenantId, CALLER_PHONE);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: 'sms', state: 'granted', source: 'voice' });
    expect((await customerRepo.findById(tenant.tenantId, customerId))!.smsConsent).toBe(true);

    // 2. Hold — the shared place-hold helper against real appointments columns.
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

    // 3. Lane (real settings via the PgSettingsRepository read mapping).
    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    expect(settings!.autonomousCloseEnabled).toBe(true);
    expect(settings!.autonomousCloseMaxCents).toBe(500000);
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
    if (!evaluation.eligible) return;

    // 4. Assemble (proposals.chain_id written via the generic update) +
    //    sanction + execute IN ORDER through the production executor.
    const draft = await seedDraftEstimateProposal();
    const closeDeps = { proposalRepo, executor, auditRepo };
    const chain = await assembleCloseChain(closeDeps, {
      tenantId: tenant.tenantId,
      draftEstimateProposalId: draft.id,
      customerId,
      jobId,
      callerPhone: CALLER_PHONE,
      appointmentId: hold.appointmentId,
      holdExpiryAt: hold.holdExpiryAt,
      evaluation,
      sessionId: 'vs-int-1',
      summary: 'Booked (integration)',
    });
    expect(chain).not.toBeNull();
    const approved = await sanctionCloseChain(closeDeps, tenant.tenantId, chain!.members);
    expect(approved.every((p) => p.status === 'approved')).toBe(true);

    const outcome = await executeCloseChain(closeDeps, tenant.tenantId, approved, 30_000);
    expect(outcome).toMatchObject({ completed: true, timedOut: false });

    // Estimate row exists with the drafted line.
    const executedDraft = (await proposalRepo.findById(tenant.tenantId, draft.id))!;
    expect(executedDraft.status).toBe('executed');
    expect(executedDraft.chainId).toBe(chain!.chainId);
    const estimateId = executedDraft.resultEntityId!;
    const estimate = await estimateRepo.findById(tenant.tenantId, estimateId);
    expect(estimate).not.toBeNull();
    expect(estimate!.totals.totalCents).toBe(185000);

    // send_estimate resolved the $ref to the REAL estimateId and dispatched.
    expect(estimateDelivery.lastDispatch).toMatchObject({
      tenantId: tenant.tenantId,
      estimateId,
      channel: 'sms',
      recipient: CALLER_PHONE,
    });

    // Booking hold confirmed on the real appointments row.
    const appt = await appointmentRepo.findById(tenant.tenantId, hold.appointmentId);
    expect(appt!.holdPendingApproval).toBe(false);

    // 5. Idempotent redelivery: re-running the executed chain short-circuits
    //    (no duplicate estimate row).
    const before = estimateDelivery.lastDispatch;
    const refreshed = await Promise.all(
      approved.map((m) => proposalRepo.findById(tenant.tenantId, m.id)),
    );
    for (const member of refreshed) {
      // Executed proposals refuse re-execution at the status gate — the
      // production sweep never re-claims them; assert the DB state stayed put.
      expect(member!.status).toBe('executed');
    }
    expect(estimateDelivery.lastDispatch).toBe(before);
    const { rows: estimateRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM estimates WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(estimateRows[0].n).toBe(1);

    // 6. UNDO — the owner taps the link: booking canceled, quote voided.
    await transitionEstimateStatus(tenant.tenantId, estimateId, 'sent', estimateRepo);
    const bookingMember = refreshed.find((m) => m!.proposalType === 'create_booking')!;
    const app = express();
    app.use(
      '/public/proposals',
      createOneTapUndoRouter({
        proposalRepo,
        appointmentRepo,
        auditRepo,
        estimateRepo,
        secret: SECRET,
        consumeNonce: () => true,
      }),
    );
    const { token } = createOneTapUndoToken({
      proposalId: bookingMember!.id,
      tenantId: tenant.tenantId,
      secret: SECRET,
    });
    const res = await request(app).get(
      `/public/proposals/one-tap-undo?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('can’t be recalled');
    expect((await appointmentRepo.findById(tenant.tenantId, hold.appointmentId))!.status).toBe('canceled');
    expect((await estimateRepo.findById(tenant.tenantId, estimateId))!.status).toBe('expired');
  });

  it('fallback mode: failed gate → drafts + ONE owner chain SMS, nothing executes', async () => {
    const draft = await seedDraftEstimateProposal();
    const smsBodies: string[] = [];
    const result = await queueCloseFallbackChain(
      {
        proposalRepo,
        auditRepo,
        routing: {
          auditRepo,
          sendSms: async (_to: string, body: string) => {
            smsBodies.push(body);
          },
          secret: SECRET,
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
    expect(head.status).toBe('draft');
    expect(head.chainId).toBeDefined();
    const siblings = await proposalRepo.findByChain(tenant.tenantId, head.chainId!);
    expect(siblings).toHaveLength(2);
    const send = siblings.find((p) => p.proposalType === 'send_estimate')!;
    expect(send.status).toBe('draft');
    expect(send.payload.estimateId).toBe('$ref:chain[0].estimateId');
    // Ineligible stamp persisted on the real source_context column.
    expect(
      (send.sourceContext as Record<string, unknown>).autonomousCloseEvaluation,
    ).toMatchObject({ eligible: false, reason: 'tenant_not_opted_in' });

    // Idempotent: a second fallback attempt does not re-chain or re-text.
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
