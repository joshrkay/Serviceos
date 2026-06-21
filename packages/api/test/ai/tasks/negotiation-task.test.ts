/**
 * Unit tests for NegotiationGuardrailTaskHandler (src/ai/tasks/negotiation-task.ts).
 *
 * Exercises the handler in isolation (no router, no queue). Router-level
 * dispatch (intent 'negotiation' → '_negotiation' handler) is covered by the
 * voice-action-router suite.
 */
import { describe, it, expect } from 'vitest';
import { NegotiationGuardrailTaskHandler } from '../../../src/ai/tasks/negotiation-task';
import { NEGOTIATION_GUARDRAIL_MARKER_REASON } from '../../../src/proposals/guardrails/negotiation-guardrail';
import type { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { assertValidProposalPayload } from '../../../src/proposals/contracts';
import type { CustomerNegotiationContextProvider } from '../../../src/customers/customer-negotiation-context';
import type { CurrentQuoteResolver } from '../../../src/conversations/negotiation/current-quote-resolver';
import type { TenantSettings } from '../../../src/settings/settings';

const configuredSettingsRepo = (discountMaxBps: number) => ({
  findByTenant: async () =>
    ({
      discountMaxBps,
      discountFloorCents: 15000,
      discountNeverBelowCatalog: true,
    }) as unknown as TenantSettings,
});
const groundedQuoteResolver: CurrentQuoteResolver = {
  resolve: async () => ({ estimateId: 'est-1', quotedCents: 25000, catalogGrounded: true }),
};

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'op-1',
    message: 'can you knock fifty bucks off that quote?',
    ...overrides,
  };
}

describe('NegotiationGuardrailTaskHandler', () => {
  it('emits a capture-class callback proposal that never auto-executes', async () => {
    const handler = new NegotiationGuardrailTaskHandler();
    const { proposal, taskType } = await handler.handle(
      makeContext({ existingEntities: { customerName: 'Mr. Lee' }, conversationId: 'conv-1' }),
    );

    expect(taskType).toBe('callback');
    expect(proposal.proposalType).toBe('callback');
    // capture-class + no trust tier → stays in draft, never auto-approves.
    expect(proposal.status).toBe('draft');
    expect(proposal.payload.reason).toBe('customer_negotiation_followup');
    expect(proposal.payload.negotiationAskType).toBe('discount');
    expect(proposal.payload.transcript).toContain('knock fifty bucks off');
    expect(proposal.payload.conversationId).toBe('conv-1');
    expect(proposal.summary).toBe("Discount request from Mr. Lee — AI didn't negotiate; call back");
    expect(() => assertValidProposalPayload('callback', proposal.payload)).not.toThrow();
  });

  it('stamps a negotiation_guardrail marker so review surfaces flag it', async () => {
    const handler = new NegotiationGuardrailTaskHandler();
    const { proposal } = await handler.handle(makeContext());

    const meta = proposal.payload._meta as {
      overallConfidence?: string;
      markers?: Array<{ reason: string }>;
    };
    expect(meta?.markers?.[0]?.reason).toBe(NEGOTIATION_GUARDRAIL_MARKER_REASON);
    // 'medium' is neutral — the marker is the signal, not a low-confidence gate.
    expect(meta?.overallConfidence).toBe('medium');
  });

  it('carries a non-conceding recommendation for the detected ask type', async () => {
    const handler = new NegotiationGuardrailTaskHandler();
    const { proposal } = await handler.handle(
      makeContext({ message: 'just throw in the trip fee for free' }),
    );
    expect(proposal.payload.negotiationAskType).toBe('scope_change');
    expect(String(proposal.payload.recommendation)).toMatch(/don't commit to extra work for free/i);
  });

  it('prefers the explicit negotiationAsk entity over the raw transcript', async () => {
    const handler = new NegotiationGuardrailTaskHandler();
    const { proposal } = await handler.handle(
      makeContext({
        message: 'hi there, um, so about the bill',
        existingEntities: { negotiationAsk: 'I want a full refund' },
      }),
    );
    expect(proposal.payload.negotiationAskType).toBe('refund_leverage');
    expect(proposal.payload.askText).toBe('I want a full refund');
  });

  it('falls back to a generic ask type when no keyword matches', async () => {
    const handler = new NegotiationGuardrailTaskHandler();
    const { proposal } = await handler.handle(
      makeContext({ message: 'come on, work with me here on the number' }),
    );
    expect(proposal.payload.negotiationAskType).toBe('general');
    expect(proposal.summary).toBe(
      "Pricing pushback from the customer — AI didn't negotiate; call back",
    );
  });

  it('derives a dedup idempotency key from recordingId when present', async () => {
    const handler = new NegotiationGuardrailTaskHandler();
    const { proposal } = await handler.handle(makeContext({ recordingId: 'rec-9' }));
    expect(proposal.idempotencyKey).toBe('voice-negotiation-callback:rec-9');
  });

  it('omits the idempotency key when recordingId is absent', async () => {
    const handler = new NegotiationGuardrailTaskHandler();
    const { proposal } = await handler.handle(makeContext());
    expect(proposal.idempotencyKey).toBeUndefined();
  });
});

describe('NegotiationGuardrailTaskHandler customer context', () => {
  it('enriches the callback with LTV/recency when a customer is resolved', async () => {
    const provider: CustomerNegotiationContextProvider = {
      getContext: async () => ({
        lifetimeValueCents: 480000,
        lastSeenAt: new Date(Date.now() - 30 * 86_400_000),
        jobsCompletedCount: 6,
      }),
    };
    const handler = new NegotiationGuardrailTaskHandler(provider);
    const { proposal } = await handler.handle(
      makeContext({ existingEntities: { customerId: 'c-1', customerName: 'Mr. Lee' } }),
    );
    const cc = proposal.payload.customerContext as { lifetimeValueCents: number } | null;
    expect(cc).not.toBeNull();
    expect(cc?.lifetimeValueCents).toBe(480000);
    expect(String(proposal.payload.recommendation)).toContain('$4,800');
    expect(() => assertValidProposalPayload('callback', proposal.payload)).not.toThrow();
  });

  it('leaves context null when no customer was resolved', async () => {
    const provider: CustomerNegotiationContextProvider = {
      getContext: async () => {
        throw new Error('should not be called without a customerId');
      },
    };
    const handler = new NegotiationGuardrailTaskHandler(provider);
    const { proposal } = await handler.handle(makeContext({ existingEntities: {} }));
    expect(proposal.payload.customerContext).toBeNull();
  });

  it('degrades gracefully when the context read throws', async () => {
    const provider: CustomerNegotiationContextProvider = {
      getContext: async () => {
        throw new Error('db down');
      },
    };
    const handler = new NegotiationGuardrailTaskHandler(provider);
    const { proposal } = await handler.handle(
      makeContext({ existingEntities: { customerId: 'c-1' } }),
    );
    expect(proposal.payload.customerContext).toBeNull();
    expect(proposal.proposalType).toBe('callback'); // the callback still ships
  });
});

describe('NegotiationGuardrailTaskHandler V2 discount engine', () => {
  it('ALLOW: an in-policy ask becomes a confidence-capped callback (never auto-approves)', async () => {
    const handler = new NegotiationGuardrailTaskHandler(undefined, {
      settingsRepo: configuredSettingsRepo(1000), // 10% cap
      quoteResolver: groundedQuoteResolver,
    });
    const { proposal, taskType } = await handler.handle(
      makeContext({ message: 'can you do $230?', existingEntities: { customerId: 'c-1' } }),
    );
    expect(taskType).toBe('callback');
    expect(proposal.status).toBe('draft');
    const meta = proposal.payload._meta as { overallConfidence: string };
    expect(meta.overallConfidence).toBe('low'); // capped → cannot auto-approve
    expect(proposal.payload.approvedDiscountBps).toBe(800); // $250→$230 = 8%
  });

  it('CLARIFY: an ambiguous discount ask becomes a voice_clarification', async () => {
    const handler = new NegotiationGuardrailTaskHandler(undefined, {
      settingsRepo: configuredSettingsRepo(1000),
      quoteResolver: groundedQuoteResolver,
    });
    const { proposal, taskType } = await handler.handle(
      makeContext({ message: 'come on, give me a deal', existingEntities: { customerId: 'c-1' } }),
    );
    expect(taskType).toBe('voice_clarification');
    expect(proposal.proposalType).toBe('voice_clarification');
    expect(proposal.payload.reason).toBe('ambiguous_discount_target');
  });

  it('NEEDS_APPROVAL: an over-policy ask becomes an enriched owner callback', async () => {
    const handler = new NegotiationGuardrailTaskHandler(undefined, {
      settingsRepo: configuredSettingsRepo(1000),
      quoteResolver: groundedQuoteResolver,
    });
    const { proposal, taskType } = await handler.handle(
      makeContext({ message: 'knock $50 off', existingEntities: { customerId: 'c-1' } }),
    );
    expect(taskType).toBe('callback');
    expect(proposal.status).toBe('draft');
    // 20% off exceeds the 10% policy → enriched with the concrete figures.
    expect(String(proposal.payload.recommendation)).toMatch(/\$250 quote|sign-off/i);
  });

  it('fail-closed: an unconfigured tenant (maxDiscountBps 0) stays on the V1 callback', async () => {
    const handler = new NegotiationGuardrailTaskHandler(undefined, {
      settingsRepo: configuredSettingsRepo(0),
      quoteResolver: groundedQuoteResolver,
    });
    const { proposal, taskType } = await handler.handle(
      makeContext({
        message: "that's too expensive, can you do $230?",
        existingEntities: { customerId: 'c-1' },
      }),
    );
    expect(taskType).toBe('callback');
    expect(proposal.payload.negotiationAskType).toBe('discount'); // V1 content
    expect(proposal.payload.approvedDiscountBps).toBeUndefined(); // no ALLOW figures
  });
});
