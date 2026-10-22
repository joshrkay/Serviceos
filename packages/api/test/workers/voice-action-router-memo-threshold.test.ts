/**
 * OVAS-04 (item 1) — the tenant's auto-approve rules apply to recorded memos.
 *
 * The bug: voice-action-router threaded the tenant override but never a
 * supervisorMode, and resolveAutoApproveThreshold returned the legacy 0.9 as
 * soon as the mode was undefined — before it read the override. So on the
 * memo surface the per-mode defaults (tech 0.95) and the owner's Settings →
 * AI approval rules were silently ignored: an "all 1.0" tenant still got
 * machine-approved memo bookings.
 *
 * Fix: the router threads the memo creator's users.current_mode (the same
 * signal chat reads from req.auth.mode), and the resolver no longer drops an
 * override when a mode is missing (unit-pinned in auto-approve.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/analytics/posthog', () => ({
  recordVoiceError: vi.fn(),
}));

import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import type { LLMGateway, LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';
import type { VoiceRecording, VoiceRepository } from '../../src/voice/voice-service';
import type { VoiceActionRouterPayload } from '../../src/workers/voice-action-router';
import type { Mode } from '../../src/proposals/auto-approve';
import { createMemoCreatorModeLoader } from '../../src/workers/memo-creator-mode';
import { InMemoryUserModeService, type MeUserRecord, type UserModeService } from '../../src/routes/me';

const TENANT = 't-ovas04-memo';
const RECORDING_ID = 'rec-ovas04';

function silentLogger(): Logger {
  const noop = (..._args: unknown[]) => {};
  const base = { debug: noop, info: noop, warn: noop, error: noop, child: () => base } as unknown as Logger;
  return base;
}

function msg(payload: VoiceActionRouterPayload): QueueMessage<VoiceActionRouterPayload> {
  return {
    id: 'msg-ovas04',
    type: 'voice_action_router',
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-ovas04',
    createdAt: new Date().toISOString(),
  };
}

function bookingGateway(draftConfidence: number): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest): Promise<LLMResponse> => {
      const content =
        req.taskType === 'classify_intent'
          ? JSON.stringify({
              intentType: 'create_appointment',
              confidence: 0.97,
              extractedEntities: { customerName: 'Mrs Lee', dateTimeDescription: 'next Tuesday 2pm' },
            })
          : req.taskType === 'create_appointment'
            ? JSON.stringify({
                customerName: 'Mrs Lee',
                scheduledStart: '2026-04-21T21:00:00Z',
                scheduledEnd: '2026-04-21T22:00:00Z',
                confidence_score: draftConfidence,
              })
            : '{}';
      return { content, model: 'mock', provider: 'mock', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1 };
    }),
  } as unknown as LLMGateway;
}

const ownerMemo: Pick<VoiceRepository, 'findById' | 'recordAnswer'> = {
  findById: vi.fn(async (tenantId: string, id: string) =>
    ({
      id,
      tenantId,
      source: 'inapp_voice',
      transcriptMetadata: { provenance: 'operator' },
      createdBy: 'clerk-owner',
      status: 'completed',
    }) as Partial<VoiceRecording> as VoiceRecording,
  ),
  recordAnswer: vi.fn(async () => null) as unknown as VoiceRepository['recordAnswer'],
};

describe('OVAS-04 — memo auto-approval honours the creator’s mode and the tenant rules', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    setSupervisorPresenceLoader(async () => true);
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  async function route(opts: {
    draftConfidence: number;
    mode?: Mode | null;
    override?: Partial<Record<Mode, number>>;
  }) {
    const worker = createVoiceActionRouterWorker({
      gateway: bookingGateway(opts.draftConfidence),
      proposalRepo,
      voiceRepo: ownerMemo,
      tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      resolveMemberRole: async () => 'owner',
      ...(opts.mode !== undefined ? { resolveMemberMode: async () => opts.mode ?? null } : {}),
      ...(opts.override ? { thresholdResolver: async () => opts.override } : {}),
    });
    await worker.handle(
      msg({ tenantId: TENANT, userId: 'system', transcript: 'Book Mrs Lee next Tuesday at 2pm', recordingId: RECORDING_ID }),
      silentLogger(),
    );
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal.proposalType).toBe('create_appointment');
    return proposal;
  }

  it("a creator in 'tech' mode gets the tech threshold (0.95): a 0.93 booking is held", async () => {
    const proposal = await route({ draftConfidence: 0.93, mode: 'tech' });
    expect(proposal.status).not.toBe('approved');
  });

  it("the same 0.93 booking from a creator in 'supervisor' mode still auto-approves (0.90)", async () => {
    const proposal = await route({ draftConfidence: 0.93, mode: 'supervisor' });
    expect(proposal.status).toBe('approved');
  });

  it('an all-1.0 tenant rule holds a 0.95 memo booking', async () => {
    const proposal = await route({
      draftConfidence: 0.95,
      mode: 'supervisor',
      override: { supervisor: 1, tech: 1, both: 1 },
    });
    expect(proposal.status).not.toBe('approved');
  });

  it('an all-1.0 tenant rule holds it even when the mode cannot be resolved', async () => {
    const proposal = await route({
      draftConfidence: 0.95,
      mode: null,
      override: { supervisor: 1, tech: 1, both: 1 },
    });
    expect(proposal.status).not.toBe('approved');
  });
});

// C-1698-P1 — the PRODUCTION creator-mode loader. app.ts used to wire the
// request middleware's resolveUserMode here, which turns a missing user or a
// DB error into a cached 'supervisor' — the permissive threshold — so a memo
// whose creator holds a stricter mode could auto-approve between the two
// thresholds. createMemoCreatorModeLoader is nullable (missing user → null)
// and error-preserving (a DB error rejects), so memoCreator.mode() returns
// undefined and the strictest defined tenant rule applies.
describe('C-1698-P1 — the memo creator-mode loader fails closed', () => {
  // A permission-holding creator; 'tech' is the stricter mode (0.97).
  const OVERRIDE = { supervisor: 0.9, tech: 0.97, both: 0.97 };
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    setSupervisorPresenceLoader(async () => true);
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  function memoBy(createdBy: string): Pick<VoiceRepository, 'findById' | 'recordAnswer'> {
    return {
      findById: vi.fn(async (tenantId: string, id: string) =>
        ({
          id,
          tenantId,
          source: 'inapp_voice',
          transcriptMetadata: { provenance: 'operator' },
          createdBy,
          status: 'completed',
        }) as Partial<VoiceRecording> as VoiceRecording,
      ),
      recordAnswer: vi.fn(async () => null) as unknown as VoiceRepository['recordAnswer'],
    };
  }

  function member(userId: string, mode: Mode): MeUserRecord {
    return {
      user_id: userId,
      tenant_id: TENANT,
      role: 'dispatcher',
      can_field_serve: false,
      current_mode: mode,
      mode_changed_at: null,
    };
  }

  async function routeWith(service: Pick<UserModeService, 'getUser'>, createdBy: string) {
    const warnings: string[] = [];
    const noop = () => {};
    const log = {
      debug: noop,
      info: noop,
      error: noop,
      warn: (message: string) => warnings.push(message),
      child: () => log,
    } as unknown as Logger;
    const worker = createVoiceActionRouterWorker({
      gateway: bookingGateway(0.93),
      proposalRepo,
      voiceRepo: memoBy(createdBy),
      tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      resolveMemberRole: async () => 'dispatcher',
      resolveMemberMode: createMemoCreatorModeLoader(() => service),
      thresholdResolver: async () => OVERRIDE,
    });
    await worker.handle(
      msg({ tenantId: TENANT, userId: 'system', transcript: 'Book Mrs Lee next Tuesday at 2pm', recordingId: RECORDING_ID }),
      log,
    );
    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal.proposalType).toBe('create_appointment');
    return { proposal, warnings };
  }

  it("reads the creator's real mode: 'supervisor' approves a 0.93 booking, 'tech' holds it", async () => {
    const service = new InMemoryUserModeService();
    service.upsertUser(member('clerk-p1-supervisor', 'supervisor'));
    service.upsertUser(member('clerk-p1-tech', 'tech'));

    expect((await routeWith(service, 'clerk-p1-supervisor')).proposal.status).toBe('approved');
    proposalRepo = new InMemoryProposalRepository();
    expect((await routeWith(service, 'clerk-p1-tech')).proposal.status).not.toBe('approved');
  });

  it('a creator with no users row gets the strictest tenant rule, not supervisor: the 0.93 booking is held', async () => {
    const { proposal } = await routeWith(new InMemoryUserModeService(), 'clerk-p1-missing');

    expect(proposal.status).not.toBe('approved');
  });

  it('a DB error gets the strictest tenant rule, not supervisor — and says so in the log', async () => {
    const failing: Pick<UserModeService, 'getUser'> = {
      getUser: async () => {
        throw new Error('connection terminated');
      },
    };

    const { proposal, warnings } = await routeWith(failing, 'clerk-p1-db-error');

    expect(proposal.status).not.toBe('approved');
    expect(warnings).toContain(
      'voice-action-router: memo creator mode lookup failed — strictest tenant rule applies',
    );
  });

  it('is nullable and error-preserving on its own', async () => {
    const service = new InMemoryUserModeService();
    service.upsertUser(member('clerk-p1-both', 'both'));
    const load = createMemoCreatorModeLoader(() => service);

    await expect(load(TENANT, 'clerk-p1-both')).resolves.toBe('both');
    await expect(load(TENANT, 'clerk-p1-nobody')).resolves.toBeNull();
    await expect(load('t-other-tenant', 'clerk-p1-both')).resolves.toBeNull();
    const boom = createMemoCreatorModeLoader(() => ({
      getUser: async () => {
        throw new Error('db down');
      },
    }));
    await expect(boom(TENANT, 'clerk-p1-both')).rejects.toThrow('db down');
  });
});
