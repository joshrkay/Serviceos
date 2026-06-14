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
