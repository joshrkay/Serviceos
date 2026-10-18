/**
 * OVAS-02 — a recorded in-app memo auto-approves only for a memo creator
 * whose role holds the proposal type's direct permission.
 *
 * The bug: POST /api/voice/recordings needs only `files:upload`, so a
 * technician could record "book Mrs Miller Tuesday at 2", and the router
 * applied no role check at all — the autonomous booking was born 'approved'
 * with a supervisor present, the execution sweep ran it, and
 * CreateBookingExecutionHandler confirmed the slot and texted + emailed the
 * customer. The chat route already blocked exactly this for technicians.
 *
 * The creator is voice_recordings.created_by (the queue job's userId can be
 * 'system'), resolved through the membership loader; anything unresolvable
 * fails closed. The D-015 autonomous lane is not gated here (covered by
 * voice-action-router-autonomous-lane.test.ts, which still auto-approves).
 *
 * Seam: a real `voice_action_router` message through the worker with a
 * mocked gateway and in-memory repos, then a real execution sweep.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/analytics/posthog', () => ({
  recordVoiceError: vi.fn(),
}));

import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { runExecutionSweep } from '../../src/workers/execution-worker';
import type { ProposalExecutor } from '../../src/proposals/execution/executor';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';
import type { VoiceRecording, VoiceRepository } from '../../src/voice/voice-service';
import type { VoiceActionRouterPayload } from '../../src/workers/voice-action-router';

const TENANT = 't-ovas02-memo';
const RECORDING_ID = 'rec-ovas02';
const JOB_ID = '00000000-0000-4000-8000-0000000ba5e1';
const MEMBERS: Record<string, string> = {
  'clerk-owner': 'owner',
  'clerk-dispatcher': 'dispatcher',
  'clerk-tech': 'technician',
};

function silentLogger(): Logger {
  const noop = (..._args: unknown[]) => {};
  const base = { debug: noop, info: noop, warn: noop, error: noop, child: () => base } as unknown as Logger;
  return base;
}

function msg(payload: VoiceActionRouterPayload): QueueMessage<VoiceActionRouterPayload> {
  return {
    id: 'msg-ovas02',
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-ovas02',
    createdAt: new Date().toISOString(),
  };
}

/** Classifier, then the create_appointment drafting call, by taskType. */
function bookingGateway(): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      const content =
        req.taskType === 'classify_intent'
          ? JSON.stringify({
              intentType: 'create_appointment',
              confidence: 0.97,
              extractedEntities: { dateTimeDescription: 'tomorrow at 2pm' },
            })
          : req.taskType === 'create_appointment'
            ? JSON.stringify({
                dateTimePhrase: 'tomorrow at 2pm',
                jobId: JOB_ID,
                summary: 'AC repair',
                confidence_score: 0.97,
              })
            : '{}';
      return { content, model: 'mock', provider: 'mock', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1 };
    }),
  } as unknown as LLMGateway;
}

/** A stamped, trusted in-app memo recorded by `createdBy`. */
function memoBy(createdBy: string): Pick<VoiceRepository, 'findById' | 'recordAnswer'> {
  return {
    findById: vi.fn(async (tenantId: string, id: string) =>
      tenantId === TENANT && id === RECORDING_ID
        ? ({
            id,
            tenantId,
            source: 'inapp_voice',
            transcriptMetadata: { provenance: 'operator' },
            createdBy,
            status: 'completed',
          } as Partial<VoiceRecording> as VoiceRecording)
        : null,
    ),
    recordAnswer: vi.fn(async () => null) as unknown as VoiceRepository['recordAnswer'],
  };
}

describe('OVAS-02 — voice memo auto-approval is gated on the memo creator’s role', () => {
  let proposalRepo: InMemoryProposalRepository;
  let appointmentRepo: InMemoryAppointmentRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    setSupervisorPresenceLoader(async () => true);
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  async function routeMemo(opts: {
    createdBy: string;
    resolveMemberRole?: (tenantId: string, userId: string) => Promise<string | null>;
    userId?: string;
  }) {
    const worker = createVoiceActionRouterWorker({
      gateway: bookingGateway(),
      proposalRepo,
      appointmentRepo,
      voiceRepo: memoBy(opts.createdBy),
      tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      slotConflictChecker: { check: async () => ({ ok: true as const }) },
      ...(opts.resolveMemberRole ? { resolveMemberRole: opts.resolveMemberRole } : {}),
    });
    await worker.handle(
      msg({
        tenantId: TENANT,
        // The job's userId is not trusted for the role: the recording is.
        userId: opts.userId ?? 'system',
        transcript: 'Book the AC repair tomorrow at 2pm',
        recordingId: RECORDING_ID,
      }),
      silentLogger(),
    );
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_booking');
    return proposals[0];
  }

  const membership = async (tenantId: string, userId: string) =>
    tenantId === TENANT ? (MEMBERS[userId] ?? null) : null;

  /** Run a real sweep; the executor is a spy, so "called" = the booking ran. */
  async function sweep(): Promise<ReturnType<typeof vi.fn>> {
    const execute = vi.fn(async () => ({ result: { success: true } }));
    await runExecutionSweep({
      proposalRepo,
      executor: { execute } as unknown as ProposalExecutor,
      logger: silentLogger(),
      auditRepo: new InMemoryAuditRepository(),
      windowMs: 0,
    });
    return execute;
  }

  it('a TECHNICIAN-created memo booking is held for review and never executes', async () => {
    const proposal = await routeMemo({ createdBy: 'clerk-tech', resolveMemberRole: membership });
    expect(proposal.status).toBe('ready_for_review');
    expect(proposal.approvedAt).toBeUndefined();
    // Nothing for the sweep to run → no confirmation SMS / email can go out.
    expect(await sweep()).not.toHaveBeenCalled();
  });

  it("the job's userId cannot launder the role: a technician's recording stays held even if userId names the owner", async () => {
    const proposal = await routeMemo({
      createdBy: 'clerk-tech',
      userId: 'clerk-owner',
      resolveMemberRole: membership,
    });
    expect(proposal.status).toBe('ready_for_review');
  });

  it('an OWNER-created memo booking keeps the auto-approval (no behavior change)', async () => {
    const proposal = await routeMemo({ createdBy: 'clerk-owner', resolveMemberRole: membership });
    expect(proposal.status).toBe('approved');
    expect(await sweep()).toHaveBeenCalledTimes(1);
  });

  it('a DISPATCHER (holds appointments:create) keeps the auto-approval', async () => {
    const proposal = await routeMemo({ createdBy: 'clerk-dispatcher', resolveMemberRole: membership });
    expect(proposal.status).toBe('approved');
  });

  it('FAIL-CLOSED: no role resolver wired → held', async () => {
    const proposal = await routeMemo({ createdBy: 'clerk-owner' });
    expect(proposal.status).toBe('ready_for_review');
  });

  it('FAIL-CLOSED: an unknown / removed member → held', async () => {
    const proposal = await routeMemo({ createdBy: 'clerk-gone', resolveMemberRole: membership });
    expect(proposal.status).toBe('ready_for_review');
  });

  it('FAIL-CLOSED: a resolver error → held', async () => {
    const proposal = await routeMemo({
      createdBy: 'clerk-owner',
      resolveMemberRole: async () => {
        throw new Error('db down');
      },
    });
    expect(proposal.status).toBe('ready_for_review');
  });
});
