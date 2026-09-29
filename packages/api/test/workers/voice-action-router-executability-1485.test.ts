/**
 * #1485 — the voice-action-router (recorded memo) runs the SAME executability
 * check a tap runs (executabilityGaps, via holdForExecutability) before it
 * persists a proposal its status decision auto-approved. A card that cannot
 * execute — an estimate for a customer with no service location — is held for
 * review instead of auto-approving into an execution failure, and the owner's
 * unsupervised SMS asks for the missing piece instead of offering a one-tap
 * approve the approval would refuse.
 *
 * Seam: createVoiceActionRouterWorker().handle with a gateway scripted per
 * task type, a stub EntityResolver and in-memory repos (the #1480 chat test's
 * fixture, on the memo surface).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryCatalogItemRepository, createCatalogItem } from '../../src/catalog/catalog-item';
import { serviceLocationReferenceCheck } from '../../src/proposals/approval-reference-checks';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { EntityResolver } from '../../src/ai/resolution/entity-resolver';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';

const TENANT = '11111111-1111-4111-8111-111111111485';
const USER = '22222222-2222-4222-8222-222222221485';
const NOLO = '33333333-3333-4333-8333-333333331485';

function silentLogger(): Logger {
  const noop = (..._args: unknown[]) => {};
  const base = { debug: noop, info: noop, warn: noop, error: noop, child: () => base } as unknown as Logger;
  return base;
}

function gatewayByTask(replies: Record<string, string>): LLMGateway {
  return {
    complete: vi.fn(
      async (req: { taskType?: string }) =>
        ({
          content: replies[req.taskType ?? ''] ?? '{}',
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

const resolvesNolo = {
  resolve: vi.fn(async (input: { kind: string }) =>
    input.kind === 'customer'
      ? { kind: 'resolved', candidate: { id: NOLO, kind: 'customer', label: 'Nolo Cation', score: 0.99 } }
      : { kind: 'not_found' },
  ),
} as unknown as EntityResolver;

// A confident, catalog-grounded estimate — the status decision reaches
// auto-approve when a supervisor is present.
const ESTIMATE_REPLIES = {
  classify_intent: JSON.stringify({
    intentType: 'draft_estimate',
    confidence: 0.95,
    reasoning: 'test',
    extractedEntities: { customerName: 'Nolo Cation', lineItemDescriptions: ['Diagnostic Visit'] },
  }),
  draft_estimate: JSON.stringify({
    lineItems: [{ description: 'Diagnostic Visit', quantity: 1, unitPrice: 8900 }],
    notes: 'Diagnostic visit',
    validUntil: '2026-10-28',
    explanation: 'One catalog diagnostic visit.',
    confidence_score: 0.95,
  }),
};

function msg(transcript: string): QueueMessage<{ tenantId: string; userId: string; transcript: string }> {
  return {
    id: 'msg-1485',
    type: 'voice_action_router',
    payload: { tenantId: TENANT, userId: USER, transcript },
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-1485',
    createdAt: new Date().toISOString(),
  };
}

describe('#1485 — voice-action-router: drafts that cannot execute are held and the owner is asked', () => {
  let proposalRepo: InMemoryProposalRepository;
  let locationRepo: InMemoryLocationRepository;
  let catalogRepo: InMemoryCatalogItemRepository;

  beforeEach(async () => {
    proposalRepo = new InMemoryProposalRepository();
    // Nolo Cation has no service location on file.
    locationRepo = new InMemoryLocationRepository();
    catalogRepo = new InMemoryCatalogItemRepository();
    await catalogRepo.create(
      createCatalogItem({
        tenantId: TENANT,
        name: 'Diagnostic Visit',
        category: 'labor',
        unit: 'each',
        unitPriceCents: 8900,
      }),
    );
  });
  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  it('supervised: an estimate for a customer with no service location is held for review, not auto-approved', async () => {
    setSupervisorPresenceLoader(async () => true);
    const worker = createVoiceActionRouterWorker({
      gateway: gatewayByTask(ESTIMATE_REPLIES),
      proposalRepo,
      catalogRepo,
      locationRepo,
      entityResolver: resolvesNolo,
      approvalReferenceChecks: [serviceLocationReferenceCheck(locationRepo)],
    });

    await worker.handle(msg('Draft an estimate for Nolo Cation: 1 Diagnostic Visit'), silentLogger());

    const [proposal] = await proposalRepo.findByTenant(TENANT);
    expect(proposal?.proposalType).toBe('draft_estimate');
    expect(proposal?.status).toBe('ready_for_review');
  });

  it('unsupervised: the owner SMS asks for the service address and carries no one-tap approve link', async () => {
    setSupervisorPresenceLoader(async () => false);
    const sendSms = vi.fn(async (_to: string, _body: string) => {});
    const worker = createVoiceActionRouterWorker({
      gateway: gatewayByTask(ESTIMATE_REPLIES),
      proposalRepo,
      catalogRepo,
      locationRepo,
      entityResolver: resolvesNolo,
      approvalReferenceChecks: [serviceLocationReferenceCheck(locationRepo)],
      unsupervisedRouting: {
        auditRepo: new InMemoryAuditRepository(),
        sendSms,
        secret: 'test-secret',
        buildApproveUrl: (token) => `https://api.example.com/approve?token=${token}`,
        resolveOwnerPhone: async () => '+15125550100',
        resolveRouting: async () => 'queue_and_sms',
      },
    });

    await worker.handle(msg('Draft an estimate for Nolo Cation: 1 Diagnostic Visit'), silentLogger());

    expect(sendSms).toHaveBeenCalledTimes(1);
    const [, body] = sendSms.mock.calls[0];
    expect(body).toMatch(/no service location yet — what's the service address\?/);
    expect(body).not.toContain('https://api.example.com/approve?token=');
    // A texted Y would be refused too — the SMS must not invite one.
    expect(body).not.toMatch(/Reply Y/i);
  });
});
