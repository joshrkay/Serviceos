/**
 * D-045 point 8 — a voice memo drafts through the same module as chat: an id
 * the drafting model made up is scrubbed and the card asks for it, and a memo
 * the drafter could not turn into a card still gets one saying so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const refuseNextDraft = { on: false };
vi.mock('../../src/ai/drafting/draft-proposal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/drafting/draft-proposal')>();
  return {
    ...actual,
    draftProposal: async (request: Parameters<typeof actual.draftProposal>[0]) =>
      refuseNextDraft.on
        ? { kind: 'refusal', code: 'not_drafted', reason: actual.NOT_DRAFTED_REASON }
        : actual.draftProposal(request),
  };
});

import { createVoiceActionRouterWorker } from '../../src/workers/voice-action-router';
import { InMemoryProposalRepository, missingFieldsFor } from '../../src/proposals/proposal';
import {
  setSupervisorPresenceLoader,
  _resetSupervisorPresenceCache,
} from '../../src/ai/supervisor-presence';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type { IntentClassification } from '../../src/ai/orchestration/intent-classifier';
import type { QueueMessage } from '../../src/queues/queue';
import type { Logger } from '../../src/logging/logger';
import { resolvesCustomer, RESOLVED_CUSTOMER_ID } from '../helpers/resolves-customer';
import { NOT_DRAFTED_REASON } from '../../src/ai/drafting/draft-proposal';

const TENANT = 't-drafting';
const MADE_UP = '11111111-1111-4111-8111-111111111111';

function silentLogger(): Logger {
  const noop = () => {};
  const base = { debug: noop, info: noop, warn: noop, error: noop, child: () => base } as unknown as Logger;
  return base;
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

/** A booking memo whose drafting model writes a customer id nobody said. */
function bookingGateway(): LLMGateway {
  const replies = [
    JSON.stringify({
      intentType: 'create_appointment',
      confidence: 0.97,
      extractedEntities: { customerName: 'Mrs Lee', dateTimeDescription: 'next Tuesday 2pm' },
    } satisfies IntentClassification),
    JSON.stringify({
      customerId: MADE_UP,
      scheduledStart: '2026-04-21T21:00:00Z',
      scheduledEnd: '2026-04-21T22:00:00Z',
      confidence_score: 0.97,
    }),
  ];
  let i = 0;
  return {
    complete: vi.fn(
      async () =>
        ({
          content: replies[i++] ?? replies[replies.length - 1],
          model: 'mock',
          provider: 'mock',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        }) satisfies LLMResponse,
    ),
  } as unknown as LLMGateway;
}

describe('voice memo drafting (D-045 point 8)', () => {
  let proposalRepo: InMemoryProposalRepository;

  beforeEach(() => {
    proposalRepo = new InMemoryProposalRepository();
    setSupervisorPresenceLoader(async () => true);
    refuseNextDraft.on = false;
  });

  afterEach(() => {
    _resetSupervisorPresenceCache();
    setSupervisorPresenceLoader(null);
  });

  async function route(deps: Partial<Parameters<typeof createVoiceActionRouterWorker>[0]> = {}) {
    const worker = createVoiceActionRouterWorker({
      gateway: bookingGateway(),
      proposalRepo,
      tenantSchedulingResolver: async () => ({ timezone: 'America/Phoenix' }),
      ...deps,
    });
    await worker.handle(
      msg({ tenantId: TENANT, userId: 'u-1', transcript: 'Book Mrs Lee next Tuesday at 2pm', recordingId: 'rec-1' }),
      silentLogger(),
    );
    return proposalRepo.findByTenant(TENANT);
  }

  it('scrubs a customer id the drafting model made up, and the booking asks for the customer', async () => {
    const [proposal] = await route();

    expect(proposal.proposalType).toBe('create_appointment');
    expect(proposal.payload.customerId).toBeUndefined();
    expect(missingFieldsFor(proposal)).toContain('customerId');
    expect(proposal.status).not.toBe('approved');
  });

  it("uses the customer the resolver verified, in place of the model's", async () => {
    const [proposal] = await route({ entityResolver: resolvesCustomer() });

    expect(proposal.payload.customerId).toBe(RESOLVED_CUSTOMER_ID);
    expect(missingFieldsFor(proposal)).not.toContain('customerId');
  });

  it('a memo the drafter turns into nothing gets a clarification card, never a broken proposal', async () => {
    refuseNextDraft.on = true;
    const proposals = await route();

    expect(proposals.map((p) => p.proposalType)).toEqual(['voice_clarification']);
    // The card says drafting's own reason, not "didn't catch that".
    expect(proposals[0].explanation).toBe(NOT_DRAFTED_REASON);
    expect(proposals[0].payload.reason).toBe('missing_entities');
  });
});
