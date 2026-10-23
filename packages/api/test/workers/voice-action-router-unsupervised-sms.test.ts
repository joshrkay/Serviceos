/**
 * P12-004 wiring — unsupervised proposal routing in the voice-action-router.
 *
 * With no supervisor present and tenant routing `queue_and_sms`, a voice
 * booking that would have auto-approved lands in `ready_for_review`, the
 * owner gets a one-tap SMS containing the signed approve link, and an
 * `unsupervised_proposal_routed` audit event is emitted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { verifyOneTapApproveToken, createInMemoryNonceStore } from '../../src/proposals/auto-approve';
import { resolveApprovalSmsRecipient, resolveApproverRole } from '../../src/proposals/approver-identity';
import type { SettingsRepository } from '../../src/settings/settings';
import type { User, UserRepository } from '../../src/users/user';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import { configureSupervisorReviewGate } from '../../src/ai/supervisor/review-gate';
import { payloadWithSupervisorMarker } from '../../src/proposals/supervisor/marker';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { IntentClassification } from '../../src/ai/orchestration/intent-classifier';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

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

function bookingGateway(): LLMGateway {
  return gatewayReturning([
    JSON.stringify({
      intentType: 'create_appointment',
      confidence: 0.97,
      extractedEntities: { customerName: 'Mrs Lee', dateTimeDescription: 'next Tuesday 2pm' },
    } satisfies IntentClassification),
    JSON.stringify({
      customerName: 'Mrs Lee',
      scheduledStart: '2026-04-21T21:00:00Z',
      scheduledEnd: '2026-04-21T22:00:00Z',
      confidence_score: 0.97,
    }),
  ]);
}

describe('voice-action-router — P12-004 unsupervised routing', () => {
  let proposalRepo: InMemoryProposalRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    auditRepo = new InMemoryAuditRepository();
    setSupervisorPresenceLoader(async () => false);
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
    configureSupervisorReviewGate(null);
  });

  it('queue_and_sms: sends the owner a one-tap approve SMS and audits the routing', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = createVoiceActionRouterWorker({
    // Production always resolves a tenant zone; a booking without one now
    // asks the operator instead of guessing at US-Eastern.
    tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      gateway: bookingGateway(),
      proposalRepo,
      unsupervisedRouting: {
        auditRepo,
        sendSms,
        secret: 'test-secret',
        buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
        resolveSmsRecipient: async () => ({ phone: '+15125550100', via: 'owner_phone' as const }),
        resolveRouting: async () => 'queue_and_sms',
      },
    });

    await worker.handle(
      msg({ tenantId: 't-unsup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
      silentLogger(),
    );

    // The proposal queued (never auto-approved unsupervised).
    const proposals = await proposalRepo.findByTenant('t-unsup');
    expect(proposals).toHaveLength(1);
    expect(proposals[0].status).toBe('ready_for_review');

    // One-tap SMS to the owner with the signed link.
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = sendSms.mock.calls[0];
    expect(to).toBe('+15125550100');
    expect(body).toContain('https://api.example.com/approve?token=');
    expect(body).toContain(proposals[0].summary);

    // Audit event recorded with the effective routing.
    const events = await auditRepo.findByEntity('t-unsup', 'proposal', proposals[0].id);
    const routed = events.find((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed).toBeDefined();
    expect(routed?.metadata).toMatchObject({
      requestedRouting: 'queue_and_sms',
      effectiveRouting: 'queue_and_sms',
      smsSent: true,
    });
  });

  // B1 — a tenant with no owner phone texts the link to the backup
  // supervisor; the link must approve as them, not as 'owner'.
  it("queue_and_sms to the backup supervisor's mobile mints a link that carries their role", async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const lookups: string[] = [];
    const worker = createVoiceActionRouterWorker({
      tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      gateway: bookingGateway(),
      proposalRepo,
      unsupervisedRouting: {
        auditRepo,
        sendSms,
        secret: 'test-secret',
        buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
        resolveSmsRecipient: async () => ({ phone: '+15125550111', via: 'backup_supervisor' as const }),
        resolveLinkApprover: async (_tenantId, phone) => {
          lookups.push(phone);
          return { role: 'dispatcher', userId: 'clerk-backup', via: 'backup_supervisor' };
        },
        resolveRouting: async () => 'queue_and_sms',
      },
    });

    await worker.handle(
      msg({ tenantId: 't-unsup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
      silentLogger(),
    );

    expect(lookups).toEqual(['+15125550111']);
    const [, body] = sendSms.mock.calls[0];
    const token = body.match(/token=([A-Za-z0-9._-]+)/)![1];
    const verified = await verifyOneTapApproveToken({
      token,
      secret: 'test-secret',
      consumeNonce: createInMemoryNonceStore(),
    });
    expect(verified).toMatchObject({ ok: true, approver: { userId: 'clerk-backup', role: 'dispatcher' } });
  });

  // B1 follow-up — a legacy technician backup gets no link (they cannot
  // approve), and their texted Y / N / EDIT are all refused. The body must
  // not ask them for any of those replies.
  it('queue_and_sms to a technician backup sends the for-your-info form: no Reply Y, no N, no link', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const recordSmsEvent = vi.fn(async () => {});
    const worker = createVoiceActionRouterWorker({
      tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      gateway: bookingGateway(),
      proposalRepo,
      unsupervisedRouting: {
        auditRepo,
        sendSms,
        secret: 'test-secret',
        buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
        resolveSmsRecipient: async () => ({ phone: '+15125550111', via: 'backup_supervisor' as const }),
        resolveLinkApprover: async () => ({ role: 'technician', userId: 'clerk-tech', via: 'backup_supervisor' }),
        resolveRouting: async () => 'queue_and_sms',
        recordSmsEvent,
      },
    });

    await worker.handle(
      msg({ tenantId: 't-unsup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
      silentLogger(),
    );

    const [proposal] = await proposalRepo.findByTenant('t-unsup');
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = sendSms.mock.calls[0];
    expect(to).toBe('+15125550111');
    expect(body).toContain(proposal.summary);
    expect(body).toContain('For your info — the owner needs to review this in the app.');
    expect(body).not.toMatch(/Reply Y/i);
    expect(body).not.toMatch(/reply N|N to reject/i);
    expect(body).not.toMatch(/EDIT/);
    expect(body).not.toContain('token=');
    expect(recordSmsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: proposal.id, kind: 'review_required_rendered' }),
    );
    const routed = (await auditRepo.findByEntity('t-unsup', 'proposal', proposal.id)).find(
      (e) => e.eventType === 'unsupervised_proposal_routed',
    );
    expect(routed?.metadata).toMatchObject({ approveLinkSuppressed: true, suppressReason: 'recipient_cannot_approve' });
  });

  // B1 follow-up — with no owner phone the SMS goes to the backup
  // supervisor, but only while they are an active member: a deactivated
  // backup must not be texted the job details.
  describe("the backup supervisor's mobile, resolved as production wires it", () => {
    const BACKUP_ID = 'user-backup';
    const settingsRepo = {
      findByTenant: async () => ({ ownerPhone: undefined, backupSupervisorUserId: BACKUP_ID }),
    } as unknown as SettingsRepository;
    const userRepoWith = (status: 'active' | 'suspended'): Pick<UserRepository, 'findById'> => ({
      findById: async (tenantId: string, id: string) =>
        id === BACKUP_ID
          ? ({ id, tenantId, role: 'dispatcher', clerkUserId: 'clerk-backup', mobileNumber: '+15125550111', status } as User)
          : null,
    });

    async function route(status: 'active' | 'suspended') {
      const sendSms = vi.fn(async (_to: string, _body: string) => {});
      const userRepo = userRepoWith(status);
      const worker = createVoiceActionRouterWorker({
        tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
        gateway: bookingGateway(),
        proposalRepo,
        unsupervisedRouting: {
          auditRepo,
          sendSms,
          secret: 'test-secret',
          buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
          resolveSmsRecipient: (tenantId) => resolveApprovalSmsRecipient({ settingsRepo, userRepo }, tenantId),
          resolveLinkApprover: (tenantId, phone) => resolveApproverRole({ settingsRepo, userRepo }, tenantId, phone),
          resolveRouting: async () => 'queue_and_sms',
        },
      });
      await worker.handle(
        msg({ tenantId: 't-unsup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
        silentLogger(),
      );
      const [proposal] = await proposalRepo.findByTenant('t-unsup');
      const routed = (await auditRepo.findByEntity('t-unsup', 'proposal', proposal.id)).find(
        (e) => e.eventType === 'unsupervised_proposal_routed',
      );
      return { sendSms, proposal, routed };
    }

    it('an active backup is texted the approval link', async () => {
      const { sendSms, routed } = await route('active');
      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(sendSms.mock.calls[0][0]).toBe('+15125550111');
      expect(routed?.metadata).toMatchObject({ smsSent: true });
    });

    it('a deactivated backup is texted nothing; the card still waits in the queue', async () => {
      const { sendSms, proposal, routed } = await route('suspended');
      expect(sendSms).not.toHaveBeenCalled();
      expect(proposal.status).toBe('ready_for_review');
      expect(routed?.metadata).toMatchObject({ requestedRouting: 'queue_and_sms', smsSent: false });
    });
  });

  // B3-2 — the recipient lookup ran again for every outgoing text, and a
  // failure became "cannot approve": a settings read that failed just after
  // the phone was picked sent the OWNER the for-your-info form. The owner
  // phone is the owner by definition and is not looked up again; a backup
  // whose lookup fails still gets no link.
  describe('a link lookup that fails after the phone was picked, as production wires it', () => {
    const BACKUP_ID = 'user-backup';
    function settingsFailingAfterFirstRead(ownerPhone: string | undefined): SettingsRepository {
      let reads = 0;
      return {
        findByTenant: async () => {
          reads += 1;
          if (reads > 1) throw new Error('settings read timed out');
          return { ownerPhone, backupSupervisorUserId: BACKUP_ID };
        },
      } as unknown as SettingsRepository;
    }
    const userRepo: Pick<UserRepository, 'findById'> = {
      findById: async (tenantId: string, id: string) =>
        id === BACKUP_ID
          ? ({ id, tenantId, role: 'dispatcher', clerkUserId: 'clerk-backup', mobileNumber: '+15125550111', status: 'active' } as User)
          : null,
    };

    async function route(ownerPhone: string | undefined) {
      const sendSms = vi.fn(async (_to: string, _body: string) => {});
      const settingsRepo = settingsFailingAfterFirstRead(ownerPhone);
      const worker = createVoiceActionRouterWorker({
        tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
        gateway: bookingGateway(),
        proposalRepo,
        unsupervisedRouting: {
          auditRepo,
          sendSms,
          secret: 'test-secret',
          buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
          resolveSmsRecipient: (tenantId) => resolveApprovalSmsRecipient({ settingsRepo, userRepo }, tenantId),
          resolveLinkApprover: (tenantId, phone) => resolveApproverRole({ settingsRepo, userRepo }, tenantId, phone),
          resolveRouting: async () => 'queue_and_sms',
        },
      });
      await worker.handle(
        msg({ tenantId: 't-unsup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
        silentLogger(),
      );
      const [proposal] = await proposalRepo.findByTenant('t-unsup');
      return { sendSms, proposal };
    }

    it('the owner phone still gets the approval link and the normal reply prompt', async () => {
      const { sendSms, proposal } = await route('+15125550100');

      expect(sendSms).toHaveBeenCalledTimes(1);
      const [to, body] = sendSms.mock.calls[0];
      expect(to).toBe('+15125550100');
      expect(body).toContain('https://api.example.com/approve?token=');
      expect(body).toMatch(/Reply Y/);
      expect(body).not.toContain('For your info');
      const routed = (await auditRepo.findByEntity('t-unsup', 'proposal', proposal.id)).find(
        (e) => e.eventType === 'unsupervised_proposal_routed',
      );
      expect(routed?.metadata).not.toHaveProperty('suppressReason');
    });

    it("the backup's mobile fails closed: the for-your-info form, no link", async () => {
      const { sendSms } = await route(undefined);

      expect(sendSms).toHaveBeenCalledTimes(1);
      const [to, body] = sendSms.mock.calls[0];
      expect(to).toBe('+15125550111');
      expect(body).toContain('For your info — the owner needs to review this in the app.');
      expect(body).not.toContain('token=');
    });
  });

  it('queue_and_sms: a non-holding supervisor review attaches an N-002 marker that reaches the rendered SMS', async () => {
    // N-004 regression: the gate writes supervisor markers to the proposal via
    // proposalRepo but historically returned only `{ hold }`, leaving the
    // router's in-memory `outcome.proposal` stale — so the queued one-tap SMS
    // omitted the freshly-attached supervisor warning. The gate now returns the
    // updated proposal and the router renders THAT. Shadow (non-holding) verdict
    // + queue_and_sms: the marker must appear in the SMS body.
    const supervisorReason = 'pricing 40% above catalog';
    configureSupervisorReviewGate({
      review: async ({ proposal }) => {
        // Mirror the real gate: force a medium _meta so the marker renders as a
        // `Check:` line, attach the supervisor marker, do NOT hold.
        const marked = payloadWithSupervisorMarker(
          { ...proposal.payload, _meta: { overallConfidence: 'medium' } },
          [supervisorReason],
        );
        return { hold: false, proposal: { ...proposal, payload: marked } };
      },
    });

    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = createVoiceActionRouterWorker({
    // Production always resolves a tenant zone; a booking without one now
    // asks the operator instead of guessing at US-Eastern.
    tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      gateway: bookingGateway(),
      proposalRepo,
      unsupervisedRouting: {
        auditRepo,
        sendSms,
        secret: 'test-secret',
        buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
        resolveSmsRecipient: async () => ({ phone: '+15125550100', via: 'owner_phone' as const }),
        resolveRouting: async () => 'queue_and_sms',
      },
    });

    await worker.handle(
      msg({ tenantId: 't-unsup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
      silentLogger(),
    );

    expect(sendSms).toHaveBeenCalledTimes(1);
    const [, body] = sendSms.mock.calls[0];
    // The supervisor warning rendered from the gate-updated payload, not the
    // stale outcome.proposal (which had no marker).
    expect(body).toContain(`supervisor: ${supervisorReason}`);
  });

  it('queue_only: no SMS is sent, routing decision is still audited', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = createVoiceActionRouterWorker({
    // Production always resolves a tenant zone; a booking without one now
    // asks the operator instead of guessing at US-Eastern.
    tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      gateway: bookingGateway(),
      proposalRepo,
      unsupervisedRouting: {
        auditRepo,
        sendSms,
        secret: 'test-secret',
        resolveSmsRecipient: async () => ({ phone: '+15125550100', via: 'owner_phone' as const }),
        resolveRouting: async () => 'queue_only',
      },
    });

    await worker.handle(
      msg({ tenantId: 't-unsup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
      silentLogger(),
    );

    expect(sendSms).not.toHaveBeenCalled();
    const proposals = await proposalRepo.findByTenant('t-unsup');
    const events = await auditRepo.findByEntity('t-unsup', 'proposal', proposals[0].id);
    const routed = events.find((e) => e.eventType === 'unsupervised_proposal_routed');
    expect(routed?.metadata).toMatchObject({ effectiveRouting: 'queue_only', smsSent: false });
  });

  it('does not route when a supervisor is present', async () => {
    setSupervisorPresenceLoader(async () => true);
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = createVoiceActionRouterWorker({
    // Production always resolves a tenant zone; a booking without one now
    // asks the operator instead of guessing at US-Eastern.
    tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      gateway: bookingGateway(),
      proposalRepo,
      unsupervisedRouting: {
        auditRepo,
        sendSms,
        secret: 'test-secret',
        resolveSmsRecipient: async () => ({ phone: '+15125550100', via: 'owner_phone' as const }),
        resolveRouting: async () => 'queue_and_sms',
      },
    });

    await worker.handle(
      msg({ tenantId: 't-sup', userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm' }),
      silentLogger(),
    );

    expect(sendSms).not.toHaveBeenCalled();
    expect(auditRepo.getAll().filter((e) => e.eventType === 'unsupervised_proposal_routed')).toHaveLength(0);
  });
});
