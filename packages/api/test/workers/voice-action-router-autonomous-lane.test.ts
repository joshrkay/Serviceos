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
  }) {
    return createVoiceActionRouterWorker({
      gateway: bookingGateway(),
      proposalRepo,
      appointmentRepo,
      auditRepo,
      autonomousBookingResolver: async () => ({
        enabled: opts.laneEnabled ?? true,
        threshold: 0.95,
      }),
      unsupervisedRouting: {
        auditRepo,
        sendSms: opts.sendSms ?? (async () => {}),
        secret: SECRET,
        buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
        buildUndoUrl: (token) => `https://api.example.com/undo?token=${token}`,
        resolveOwnerPhone: async () => '+15125550100',
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
});
