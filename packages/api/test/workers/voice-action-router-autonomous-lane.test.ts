/**
 * UB-D / D-015 (D2/D3) — autonomous booking lane in the voice-action-router.
 *
 * Covers:
 *  - the `holdIfUnsupervised` chokepoint: a lane-approved booking survives;
 *    a forged eligible stamp on a NON-booking proposal type still downgrades
 *    (defense in depth — the type is re-checked against the lane's list);
 *  - the full worker path: an inbound-caller booking segment with the lane
 *    enabled persists an APPROVED create_booking, the owner gets the
 *    one-tap UNDO SMS, and `autonomous_booking_lane_evaluated` is audited;
 *  - SMS failure is best-effort (the persisted proposal is unaffected);
 *  - the lane never engages without a verified inbound caller (owner memos).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createVoiceActionRouterWorker,
  holdIfUnsupervised,
} from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository, createProposal } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { autonomousLaneStamp } from '../../src/proposals/autonomous-lane';
import { verifyOneTapUndoToken } from '../../src/proposals/one-tap-undo';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { IntentClassification } from '../../src/ai/orchestration/intent-classifier';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const TENANT = 't-lane';
const JOB_ID = '00000000-0000-4000-8000-000000000abc';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const SECRET = 'test-one-tap-secret';

function silentLogger(): Logger {
  const noop = (..._args: unknown[]) => {};
  const base = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => base,
  } as unknown as Logger;
  return base;
}

function gatewayReturning(responses: string[]): LLMGateway {
  let i = 0;
  return {
    complete: vi.fn(async () => {
      const content = responses[i++] ?? responses[responses.length - 1];
      return {
        content,
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 10, output: 10, total: 20 },
        latencyMs: 1,
      } satisfies LLMResponse;
    }),
  } as unknown as LLMGateway;
}

function bookingGateway(): LLMGateway {
  return gatewayReturning([
    JSON.stringify({
      intentType: 'create_appointment',
      confidence: 0.97,
      extractedEntities: { dateTimeDescription: 'tomorrow at 2pm' },
    } satisfies IntentClassification),
    JSON.stringify({
      dateTimePhrase: 'tomorrow at 2pm',
      jobId: JOB_ID,
      summary: 'AC repair',
      confidence_score: 0.97,
    }),
  ]);
}

function msg<T>(payload: T): QueueMessage<T> {
  return {
    id: 'msg-1',
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-1',
    createdAt: new Date().toISOString(),
  };
}

describe('holdIfUnsupervised chokepoint (UB-D)', () => {
  const base = {
    tenantId: TENANT,
    summary: 'Book Mrs Lee',
    confidenceScore: 0.97,
    createdBy: 'voice',
  };

  it('lets a lane-approved booking through when unsupervised', () => {
    const proposal = {
      ...createProposal({
        ...base,
        proposalType: 'create_booking',
        payload: { appointmentId: 'a-1' },
      }),
      status: 'approved' as const,
      sourceContext: autonomousLaneStamp({ eligible: true, threshold: 0.95 }),
    };
    const result = holdIfUnsupervised(proposal, false);
    expect(result.status).toBe('approved');
  });

  it('downgrades a forged eligible stamp on a NON-booking proposal type', () => {
    const proposal = {
      ...createProposal({
        ...base,
        proposalType: 'draft_invoice',
        payload: { lineItems: [] },
      }),
      status: 'approved' as const,
      sourceContext: autonomousLaneStamp({ eligible: true, threshold: 0.95 }),
    };
    const result = holdIfUnsupervised(proposal, false);
    expect(result.status).toBe('ready_for_review');
    expect(result.approvedAt).toBeUndefined();
  });

  it('downgrades an approved booking WITHOUT a stamp (pre-lane behavior)', () => {
    const proposal = {
      ...createProposal({
        ...base,
        proposalType: 'create_booking',
        payload: { appointmentId: 'a-1' },
      }),
      status: 'approved' as const,
    };
    expect(holdIfUnsupervised(proposal, false).status).toBe('ready_for_review');
  });

  it('downgrades an approved booking with an INELIGIBLE stamp', () => {
    const proposal = {
      ...createProposal({
        ...base,
        proposalType: 'create_booking',
        payload: { appointmentId: 'a-1' },
      }),
      status: 'approved' as const,
      sourceContext: autonomousLaneStamp({ eligible: false, reason: 'below_threshold' }),
    };
    expect(holdIfUnsupervised(proposal, false).status).toBe('ready_for_review');
  });

  it('is a no-op when a supervisor is present', () => {
    const proposal = {
      ...createProposal({
        ...base,
        proposalType: 'create_booking',
        payload: { appointmentId: 'a-1' },
      }),
      status: 'approved' as const,
    };
    expect(holdIfUnsupervised(proposal, true).status).toBe('approved');
  });
});

describe('voice-action-router — autonomous booking lane (UB-D)', () => {
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;
  let appointmentRepo: InMemoryAppointmentRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    setSupervisorPresenceLoader(async () => false);
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  function makeWorker(opts: {
    sendSms?: (to: string, body: string) => Promise<void>;
    laneEnabled?: boolean;
    platformDisabled?: boolean;
    /** tenant_settings.owner_phone as the lane resolver reads it. */
    laneOwnerPhone?: string | null;
    /** The owner-or-backup number the routing SMS goes to. */
    resolveOwnerPhone?: (tenantId: string) => Promise<string | null | undefined>;
    /** Leave the one-tap signing secret unwired (no UNDO link can be minted). */
    noUndoSecret?: boolean;
  }) {
    const resolveOwnerPhone = opts.resolveOwnerPhone ?? (async () => '+15125550100');
    return createVoiceActionRouterWorker({
    // Production always resolves a tenant zone; a booking without one now
    // asks the operator instead of guessing at US-Eastern.
    tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      gateway: bookingGateway(),
      proposalRepo,
      appointmentRepo,
      auditRepo,
      // P0-035 — the slot is checked and free (the lane requires a check).
      slotConflictChecker: { check: async () => ({ ok: true as const }) },
      autonomousBookingResolver: async () => ({
        enabled: opts.laneEnabled ?? true,
        threshold: 0.95,
        ownerPhone: opts.laneOwnerPhone === undefined ? '+15125550100' : opts.laneOwnerPhone,
      }),
      ...(opts.platformDisabled !== undefined
        ? { autonomousBookingPlatformDisabled: opts.platformDisabled }
        : {}),
      unsupervisedRouting: {
        auditRepo,
        sendSms: opts.sendSms ?? (async () => {}),
        ...(opts.noUndoSecret ? {} : { secret: SECRET }),
        buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
        buildUndoUrl: (token) => `https://api.example.com/undo?token=${token}`,
        resolveOwnerPhone,
        resolveRouting: async () => 'queue_and_sms',
      },
    });
  }

  it('inbound verified caller + lane enabled: persists an APPROVED booking, sends the UNDO SMS, audits the evaluation', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = makeWorker({ sendSms });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'u-1',
        transcript: 'Book the AC repair tomorrow at 2pm',
        // Verified inbound caller identity (caller-ID match) — the signal
        // that makes inboundReceptionistSource true on this path.
        customerId: CUSTOMER_ID,
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_booking');
    expect(proposals[0].status).toBe('approved');

    // Owner one-tap UNDO SMS with a verifiable undo token bound to the
    // proposal + tenant.
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = sendSms.mock.calls[0];
    expect(to).toBe('+15125550100');
    expect(body).toContain('Rivet booked');
    expect(body).toContain('Tap to UNDO: https://api.example.com/undo?token=');
    const token = decodeURIComponent(body.split('token=')[1]);
    const verified = await verifyOneTapUndoToken({
      token,
      secret: SECRET,
      consumeNonce: () => true,
    });
    expect(verified).toMatchObject({
      ok: true,
      proposalId: proposals[0].id,
      tenantId: TENANT,
    });

    // Evaluation audited; the unsupervised ready_for_review routing did NOT
    // fire (the proposal auto-approved).
    const events = await auditRepo.findByEntity(TENANT, 'proposal', proposals[0].id);
    const evaluated = events.find((e) => e.eventType === 'autonomous_booking_lane_evaluated');
    expect(evaluated?.metadata).toMatchObject({ eligible: true, threshold: 0.95 });
    expect(events.some((e) => e.eventType === 'unsupervised_proposal_routed')).toBe(false);
  });

  it('UNDO SMS failure is best-effort: the approved proposal is unaffected', async () => {
    const sendSms = vi.fn(async () => {
      throw new Error('twilio down');
    });
    const worker = makeWorker({ sendSms });

    await expect(
      worker.handle(
        msg({
          tenantId: TENANT,
          userId: 'u-1',
          transcript: 'Book the AC repair tomorrow at 2pm',
          customerId: CUSTOMER_ID,
        }),
        silentLogger(),
      ),
    ).resolves.toBeUndefined();

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('approved');
  });

  it('owner memo (no verified caller): lane ineligible, booking queues for review', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = makeWorker({ sendSms });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'u-1',
        transcript: 'Book the AC repair tomorrow at 2pm',
        // No customerId — the production transcription path (owner memos).
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('ready_for_review');

    const events = await auditRepo.findByEntity(TENANT, 'proposal', proposals[0].id);
    const evaluated = events.find((e) => e.eventType === 'autonomous_booking_lane_evaluated');
    expect(evaluated?.metadata).toMatchObject({
      eligible: false,
      reason: 'not_inbound_receptionist',
    });
    // The normal unsupervised routing (one-tap APPROVE SMS) took over.
    expect(events.some((e) => e.eventType === 'unsupervised_proposal_routed')).toBe(true);
    const [, body] = sendSms.mock.calls[0];
    expect(body).not.toContain('UNDO');
  });

  it('lane disabled: booking queues for review with the ineligible stamp audited', async () => {
    const worker = makeWorker({ laneEnabled: false });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'u-1',
        transcript: 'Book the AC repair tomorrow at 2pm',
        customerId: CUSTOMER_ID,
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals[0].status).toBe('ready_for_review');
    const events = await auditRepo.findByEntity(TENANT, 'proposal', proposals[0].id);
    const evaluated = events.find((e) => e.eventType === 'autonomous_booking_lane_evaluated');
    expect(evaluated?.metadata).toMatchObject({ eligible: false, reason: 'tenant_not_opted_in' });
  });

  it('D-015 amendment — platform kill switch: booking queues for review with platform_disabled audited, even though the tenant is opted in', async () => {
    const worker = makeWorker({ laneEnabled: true, platformDisabled: true });

    await worker.handle(
      msg({
        tenantId: TENANT,
        userId: 'u-1',
        transcript: 'Book the AC repair tomorrow at 2pm',
        customerId: CUSTOMER_ID,
      }),
      silentLogger(),
    );

    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals[0].status).toBe('ready_for_review');
    const events = await auditRepo.findByEntity(TENANT, 'proposal', proposals[0].id);
    const evaluated = events.find((e) => e.eventType === 'autonomous_booking_lane_evaluated');
    expect(evaluated?.metadata).toMatchObject({ eligible: false, reason: 'platform_disabled' });
  });

  function bookingMessage() {
    return msg({
      tenantId: TENANT,
      userId: 'u-1',
      transcript: 'Book the AC repair tomorrow at 2pm',
      customerId: CUSTOMER_ID,
    });
  }

  async function laneVerdict() {
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_booking');
    const events = await auditRepo.findByEntity(TENANT, 'proposal', proposals[0].id);
    const evaluated = events.find((e) => e.eventType === 'autonomous_booking_lane_evaluated');
    return { status: proposals[0].status, evaluation: evaluated?.metadata };
  }

  // Value: protects=only tenant_settings.owner_phone counts as the owner cell; a backup supervisor's mobile never qualifies a booking for the lane;
  //   fails_when=the router feeds the lane the owner-or-backup resolver (or any number other than owner_phone);
  //   why_new=router tests only ran tenants whose owner cell was set; seam=none;
  //   no_claim=the backup supervisor lookup itself (mocked resolver)
  it('no owner_phone on file: the booking queues for review as owner_cell_missing, even with a backup supervisor mobile; the review text carries no UNDO', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = makeWorker({
      sendSms,
      laneOwnerPhone: null,
      resolveOwnerPhone: async () => '+15125550777',
    });

    await expect(worker.handle(bookingMessage(), silentLogger())).resolves.toBeUndefined();

    const { status, evaluation } = await laneVerdict();
    expect(status).toBe('ready_for_review');
    expect(evaluation).toMatchObject({ eligible: false, reason: 'owner_cell_missing' });
    // The review-routing text still reaches the backup, and it is never an UNDO.
    expect(sendSms).toHaveBeenCalled();
    expect(sendSms.mock.calls.every(([to]) => to === '+15125550777')).toBe(true);
    expect(sendSms.mock.calls.some(([, body]) => body.includes('UNDO'))).toBe(false);
  });

  // Value: protects=the lane never auto-approves a booking whose owner UNDO SMS cannot be sent;
  //   fails_when=the router stops passing undoChannelAvailable, or computes it without the signing secret;
  //   why_new=router tests always wired sender, secret and undo link; seam=none;
  //   no_claim=the production env actually setting ONE_TAP_APPROVE_SECRET
  it('UNDO channel not wired (no signing secret): the booking queues for review as undo_channel_unavailable', async () => {
    const worker = makeWorker({ noUndoSecret: true });

    await expect(worker.handle(bookingMessage(), silentLogger())).resolves.toBeUndefined();

    const { status, evaluation } = await laneVerdict();
    expect(status).toBe('ready_for_review');
    expect(evaluation).toMatchObject({ eligible: false, reason: 'undo_channel_unavailable' });
  });

  // Value: protects=the UNDO SMS goes to the exact number the lane checked, with no second lookup that can fail after approval;
  //   fails_when=the UNDO block re-resolves the owner phone instead of using the lane's number;
  //   why_new=the existing UNDO test used one resolver that always succeeds; seam=none;
  //   no_claim=SMS delivery (mocked sender)
  it('the UNDO SMS goes to the lane-checked owner cell even when the owner-or-backup lookup fails', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = makeWorker({
      sendSms,
      laneOwnerPhone: '+15125550100',
      resolveOwnerPhone: async () => {
        throw new Error('settings db down');
      },
    });

    await worker.handle(bookingMessage(), silentLogger());

    const { status } = await laneVerdict();
    expect(status).toBe('approved');
    expect(sendSms).toHaveBeenCalledWith('+15125550100', expect.stringContaining('Tap to UNDO'));
  });
});
