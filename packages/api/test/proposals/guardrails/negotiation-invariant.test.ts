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

/**
 * The type-level impossibility check, as a PURE function of the registry list.
 *
 * #1021: extracted so the same predicate that audits `VALID_PROPOSAL_TYPES`
 * can be pointed at a list with a PLANTED discount type. §8.0 grants
 * STRUCTURAL only with a negative control.
 */
export function discountShapedTypes(types: readonly string[]): string[] {
  return types.filter((type) => /discount|haggle|negotiat/i.test(type));
}
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
    expect(discountShapedTypes(VALID_PROPOSAL_TYPES)).toEqual([]);
  });

  // ─── NEGATIVE CONTROL (#1021) ──────────────────────────────────────────────
  //
  // G1 2026-09-12: "§8.0's STRUCTURAL requires a negative control and
  // negotiation-invariant.test.ts plants none — it asserts the registry holds
  // no such type, and nothing shows the assertion would fail if one were
  // added." These plant one.
  //
  // The plant is a type ADDED TO A COPY of the registry list, not to
  // `VALID_PROPOSAL_TYPES` itself: the lane is test-only, and a test that
  // mutated the live registry would be proving something about its own
  // mutation rather than about the guard. The predicate under test is the
  // same function the assertion above calls.

  it('NEGATIVE CONTROL — a planted AI-discount proposal type is reported', () => {
    expect(discountShapedTypes([...VALID_PROPOSAL_TYPES, 'apply_ai_discount'])).toEqual([
      'apply_ai_discount',
    ]);
  });

  it('NEGATIVE CONTROL — the whole forbidden vocabulary is caught, not just the word "discount"', () => {
    const planted = [
      ...VALID_PROPOSAL_TYPES,
      'apply_ai_discount',
      'haggle_with_customer',
      'negotiate_price',
      'AUTO_DISCOUNT',
    ];
    expect(discountShapedTypes(planted).sort()).toEqual(
      ['AUTO_DISCOUNT', 'apply_ai_discount', 'haggle_with_customer', 'negotiate_price'].sort(),
    );
  });

  it('NEGATIVE CONTROL (inverse) — the real registry is non-trivial, so the green above is not vacuous', () => {
    // A guard over an empty list would also report nothing.
    expect(VALID_PROPOSAL_TYPES.length).toBeGreaterThanOrEqual(40);
    expect(discountShapedTypes(VALID_PROPOSAL_TYPES)).toEqual([]);
  });
});
