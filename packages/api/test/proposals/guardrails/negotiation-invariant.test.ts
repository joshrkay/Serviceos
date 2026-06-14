/**
 * P2-036 invariant: the AI can NEVER concede a discount or scope change without
 * a human-approved proposal. The negotiation guardrail's only output is a
 * capture-class `callback` that lands in 'draft' (requires a human); it carries
 * advice for the owner, never a committed price/discount. This regression guard
 * pins that restriction across every ask type — including the strongest
 * temptation (a high-value repeat customer) — and fails if a future change adds
 * an AI-reachable discount path.
 */
import { describe, it, expect } from 'vitest';
import { NegotiationGuardrailTaskHandler } from '../../../src/ai/tasks/negotiation-task';
import {
  buildNegotiationCallbackContent,
  type NegotiationAskType,
} from '../../../src/proposals/guardrails/negotiation-guardrail';
import {
  actionClassForProposalType,
  VALID_PROPOSAL_TYPES,
} from '../../../src/proposals/proposal';
import type { TaskContext } from '../../../src/ai/tasks/task-handlers';
import type { CustomerNegotiationContextProvider } from '../../../src/customers/customer-negotiation-context';

const ASKS: Record<NegotiationAskType | 'general', string> = {
  discount: 'can you knock fifty bucks off?',
  scope_change: 'just throw in the trip fee for free',
  refund_leverage: 'I want a full refund',
  manager_escalation: 'let me talk to the owner about this price',
  deadline_threat: "lower it or I'll leave a one-star review",
  general: 'come on, work with me here on the number',
};

// A high-value repeat is the strongest temptation to concede; even then the
// guardrail commits nothing.
const valuedRepeat = { lifetimeValueCents: 500000, lastSeenAt: new Date(), jobsCompletedCount: 9 };
const provider: CustomerNegotiationContextProvider = { getContext: async () => valuedRepeat };

function makeContext(message: string): TaskContext {
  return { tenantId: 't-1', userId: 'op-1', message, existingEntities: { customerId: 'c-1' } };
}

describe('P2-036 negotiation guardrail invariant', () => {
  it('only ever emits a capture-class callback that never auto-executes', async () => {
    const handler = new NegotiationGuardrailTaskHandler(provider);
    for (const message of Object.values(ASKS)) {
      const { proposal, taskType } = await handler.handle(makeContext(message));
      expect(taskType).toBe('callback');
      expect(proposal.proposalType).toBe('callback');
      // Capture-class → no AI trust tier auto-approves it; it stays in draft.
      expect(actionClassForProposalType('callback')).toBe('capture');
      expect(proposal.status).toBe('draft');
    }
  });

  it('the payload carries advice but no committed discount/price field', () => {
    for (const message of Object.values(ASKS)) {
      const content = buildNegotiationCallbackContent({
        detectText: message,
        customerContext: valuedRepeat,
      });
      const keys = Object.keys(content.payload);
      for (const forbidden of ['discountCents', 'discountBps', 'priceCents', 'approvedAmountCents']) {
        expect(keys).not.toContain(forbidden);
      }
      // Even for a valued repeat, the recommendation never offers a % discount.
      expect(String(content.payload.recommendation)).not.toMatch(/%\s*off/i);
    }
  });

  it('no proposal type exists for an AI-applied ad-hoc discount/negotiation', () => {
    // V1 blocks discounts entirely: the only discount path is a membership
    // agreement (applied by the billing engine) or a human editing an estimate.
    // If a change adds an AI-reachable discount/negotiation proposal type, this
    // guard fails so the P2-036 invariant gets re-reviewed.
    for (const type of VALID_PROPOSAL_TYPES) {
      expect(type).not.toMatch(/discount|haggle|negotiat/i);
    }
  });
});
