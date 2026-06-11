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
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
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
  });

  it('queue_and_sms: sends the owner a one-tap approve SMS and audits the routing', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = createVoiceActionRouterWorker({
      gateway: bookingGateway(),
      proposalRepo,
      unsupervisedRouting: {
        auditRepo,
        sendSms,
        secret: 'test-secret',
        buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
        resolveOwnerPhone: async () => '+15125550100',
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

  it('queue_only: no SMS is sent, routing decision is still audited', async () => {
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = createVoiceActionRouterWorker({
      gateway: bookingGateway(),
      proposalRepo,
      unsupervisedRouting: {
        auditRepo,
        sendSms,
        secret: 'test-secret',
        resolveOwnerPhone: async () => '+15125550100',
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
      gateway: bookingGateway(),
      proposalRepo,
      unsupervisedRouting: {
        auditRepo,
        sendSms,
        secret: 'test-secret',
        resolveOwnerPhone: async () => '+15125550100',
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
