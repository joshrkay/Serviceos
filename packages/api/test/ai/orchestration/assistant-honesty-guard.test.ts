/**
 * #844 — `complaint` and `negotiation` must not fall through to the generic LLM.
 *
 * `NON_ACTION_INTENTS` is a deny-list whose stated criterion is
 * "Conversational / signalling — never a write on any surface". `complaint`
 * and `negotiation` do not meet it: on the recorded-memo surface they are
 * handled by `ComplaintTaskHandler` and `NegotiationGuardrailTaskHandler`
 * (workers/voice-action-router.ts) and produce real `add_note` / `callback`
 * proposals.
 *
 * Because they were listed, chat skipped the deterministic refusal at
 * routes/assistant.ts and answered from the generic LLM — which has no
 * database access. That is the failure ai/orchestration/lookup-dispatch.ts
 * documents as having already happened once ("ai_runs had ZERO rows… answered
 * from nothing"), and a fluent fabrication is the worst outcome for a product
 * whose differentiator is telling the truth when it is wrong.
 *
 * Whether chat should EXECUTE these two is a separate scope decision (#835).
 * Refusing honestly is correct either way.
 */
import { describe, it, expect } from 'vitest';
import { isActionIntent } from '../../../src/ai/orchestration/assistant-honesty-guard';

describe('#844 — intents that write must be treated as actions', () => {
  it.each(['complaint', 'negotiation'])(
    '%s is an action intent, so chat refuses instead of improvising',
    (intent) => {
      expect(isActionIntent(intent)).toBe(true);
    },
  );
});

describe('the deny-list still covers what genuinely never writes', () => {
  it.each(['language_switch', 'operator_request', 'confirm'])(
    '%s stays conversational',
    (intent) => {
      expect(isActionIntent(intent)).toBe(false);
    },
  );

  it('unknown is a classification failure, not an action', () => {
    // Routed to buildNotUnderstoodReply, which is a different experience
    // from a capability refusal.
    expect(isActionIntent('unknown')).toBe(false);
  });

  it.each(['approve_proposal', 'reject_proposal', 'edit_proposal'])(
    '%s stays a lifecycle meta-ask',
    (intent) => {
      // Deliberate per the module doc: the useful answer is directions to the
      // proposals inbox, not a flat refusal. Voice refuses them upstream.
      expect(isActionIntent(intent)).toBe(false);
    },
  );

  it('lookup_* matches by prefix, so read-only skills need no deny-list edit', () => {
    expect(isActionIntent('lookup_my_day')).toBe(false);
    expect(isActionIntent('lookup_a_brand_new_thing')).toBe(false);
  });

  it('an unlisted intent defaults to action — the safe failure direction', () => {
    expect(isActionIntent('create_invoice')).toBe(true);
  });
});
