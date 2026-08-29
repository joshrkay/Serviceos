/**
 * #886/#887 — first-turn classifier input budget, per surface profile.
 *
 * The regression this pins: the ungated taxonomy prompt grew to ~15.2k
 * tokens against a 5k-token session cap, so every inbound call escalated on
 * the caller's first sentence (#886). The pin below measures the REAL
 * assembled first turn — profile prompt + the sections that surface always
 * appends + a rich tenant vertical pack + a long utterance — against the
 * documented per-turn budget with the same 15% safety convention the
 * voice-eval preflight uses (voice-eval-live.test.ts pins its estimate at
 * 1.15×; this test is the inverse: real usage must stay under 0.85× budget).
 *
 * If this fails, taxonomy text grew past the surface's budget: trim the
 * profile (PROFILE_INTENTS / variants in intent-taxonomy-blocks.ts) or
 * re-derive the budget and session caps TOGETHER in session-cost-tracker.ts
 * — never bump one side alone.
 */
import { describe, it, expect } from 'vitest';
import {
  buildClassifierSystemPrompt,
  PROFILE_INTENTS,
  type ClassifierProfile,
} from '../../../src/ai/orchestration/classifier-profile';
import {
  CUSTOMER_PROTECTION_PROMPT_SECTION,
  isLookupIntent,
  SYSTEM_PROMPT,
  type IntentType,
} from '../../../src/ai/orchestration/intent-classifier';
import { formatVerticalForCallerPrompt } from '../../../src/verticals/context-assembly';
import { createHvacPack } from '../../../src/verticals/packs/hvac';
import { INTENT_TO_PROPOSAL_TYPE } from '../../../src/proposals/voice-intent-map';
import { S1_ALLOWED_PROPOSAL_TYPES } from '../../../src/proposals/surface';
import {
  CLASSIFY_TURN_INPUT_TOKEN_BUDGET,
  DEFAULT_TELEPHONY_CAPS,
  EXPECTED_MAX_CLASSIFY_TURNS,
} from '../../../src/ai/skills/session-cost-tracker';

/**
 * The documented per-turn classify input budget — the basis from which
 * DEFAULT_TELEPHONY_CAPS.maxInputTokens is derived (#886). Importing the
 * real constant couples this pin to the caps: growing the prompt past the
 * budget or shrinking the cap below budget × turns fails here.
 */
const PER_TURN_CLASSIFY_INPUT_TOKEN_BUDGET = CLASSIFY_TURN_INPUT_TOKEN_BUDGET;

/** chars/4, mirroring packages/voice-eval/live-support.ts estimateTokens. */
const CHARS_PER_TOKEN = 4;
const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Margin convention: stay under 85% of budget (inverse of the 1.15× pin). */
const BUDGET_MARGIN = 0.85;

/** A deliberately long, entity-rich first utterance. */
const SAMPLE_UTTERANCE =
  "Hi, this is Maria Delgado-Whitfield calling about the house over on 412 East Oakhurst " +
  "Boulevard — our furnace has been making a rattling noise since Tuesday night and I'd " +
  "really like to get somebody out here this week, ideally Thursday morning before ten " +
  "if you can manage it, and can you tell me how much I still owe on the last visit?";

/** Mirrors classifyIntentRaw's vertical wrapper text. */
function verticalSection(): string {
  return `Tenant vertical context (use ONLY for entity recognition; do not change the JSON output schema):\n${formatVerticalForCallerPrompt(createHvacPack())}`;
}

describe('classifier prompt budget — per-profile first turn', () => {
  const cases: Array<{ profile: ClassifierProfile; sections: string[] }> = [
    // Live telephony always appends customer protection for callers.
    { profile: 'caller', sections: [CUSTOMER_PROTECTION_PROMPT_SECTION] },
    // field_tech gets no sections at all.
    { profile: 'field_tech', sections: [] },
  ];

  it.each(cases)(
    '$profile first turn (prompt + sections + HVAC pack + utterance) fits the per-turn budget with 15% margin',
    ({ profile, sections }) => {
      const firstTurn =
        buildClassifierSystemPrompt(profile) +
        sections.join('') +
        verticalSection() +
        SAMPLE_UTTERANCE;
      const tokens = estimateTokens(firstTurn);
      expect(tokens).toBeLessThan(PER_TURN_CLASSIFY_INPUT_TOKEN_BUDGET * BUDGET_MARGIN);
    },
  );

  it('operator profile remains the historical prompt (byte-identity delegated to its own pin)', () => {
    expect(buildClassifierSystemPrompt('operator')).toBe(SYSTEM_PROMPT);
  });

  it('the telephony session cap covers the expected classify turns at full budget (#886)', () => {
    // The cap is CUMULATIVE per session; it must hold budget × turns, or
    // gating only moves the first-sentence escalation from turn 1 to turn 2.
    expect(DEFAULT_TELEPHONY_CAPS.maxInputTokens).toBeGreaterThanOrEqual(
      PER_TURN_CLASSIFY_INPUT_TOKEN_BUDGET * EXPECTED_MAX_CLASSIFY_TURNS,
    );
  });

  it('every caller-profile intent is reachable-or-intercepted on S1 (nothing advertised is dead)', () => {
    // An advertised intent must either build an S1-allowlisted proposal or
    // be handled without a proposal on the live path:
    // - lookups → the shared read-only lookup dispatch (D-026)
    // - confirm / operator_request / language_switch / unknown → FSM turns
    // - complaint / negotiation → the customer-protection flow
    const interceptedOnS1 = new Set<IntentType>([
      'confirm',
      'operator_request',
      'language_switch',
      'unknown',
      'complaint',
      'negotiation',
    ]);
    for (const intent of PROFILE_INTENTS.caller) {
      const proposalType = INTENT_TO_PROPOSAL_TYPE[intent];
      const reachable =
        (proposalType !== undefined && S1_ALLOWED_PROPOSAL_TYPES.has(proposalType)) ||
        isLookupIntent(intent) ||
        interceptedOnS1.has(intent);
      expect(reachable, `caller advertises ${intent} but S1 cannot act on it`).toBe(true);
    }
  });
});
