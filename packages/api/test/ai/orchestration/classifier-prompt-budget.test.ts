/**
 * #886/#887/#902 — first-turn classifier input budget, per surface profile.
 *
 * The regression this pins: the ungated taxonomy prompt grew to ~15.2k
 * tokens against a 5k-token session cap, so every inbound call escalated on
 * the caller's first sentence (#886). The pin below measures the WORST
 * STRUCTURAL assembled first turn — profile prompt + the sections that
 * surface always appends + the full canonical HVAC pack (vertical block +
 * intake questions + objection scripts) + MAX_PROMPT_ASSETS tenant training
 * assets saturating the prompt builder's own truncation caps (#902: the
 * previous pin omitted intake/objection and training assets, leaving ~1%
 * slack against a scenario tenants can actually configure) + a long
 * utterance — against the documented per-turn budget with the same 15%
 * safety convention the voice-eval preflight uses (voice-eval-live.test.ts
 * pins its estimate at 1.15×; this test is the inverse: real usage must
 * stay under 0.85× budget).
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
import {
  buildMergedVerticalVoicePrompt,
  formatIntakeQuestionsForPrompt,
  formatObjectionScriptsForPrompt,
  formatVerticalForCallerPrompt,
} from '../../../src/verticals/context-assembly';
import { createHvacPack } from '../../../src/verticals/packs/hvac';
import {
  buildTrainingAssetPromptSection,
  MAX_PROMPT_ASSETS,
  type VerticalTrainingAsset,
} from '../../../src/verticals/training-assets';
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

/**
 * A tenant training asset saturating every prompt-visible field's own
 * truncation cap in buildTrainingAssetPromptSection (title 160, guidance
 * 1,000, both labels 300 chars — the inputs are longer on purpose; the
 * builder truncates). Together with MAX_PROMPT_ASSETS this makes the
 * training section a computable CEILING, not a sample.
 */
function maxTrainingAsset(i: number): VerticalTrainingAsset {
  return {
    id: `budget-pin-${i}`,
    tenantId: 'budget-pin',
    verticalType: 'hvac',
    assetKind: 'prompt_context',
    status: 'active',
    title: 'T'.repeat(200),
    scrubbedText: 'x'.repeat(2000),
    labels: {
      expectedNextQuestion: 'q'.repeat(400),
      expectedNextAction: 'n'.repeat(400),
    },
    provenance: { source: 'tenant_admin', sourceVersion: '1' },
    createdBy: 'budget-pin',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * Mirrors classifyIntentRaw's vertical wrapper around the WORST section
 * resolve-active-pack.ts can assemble: canonical HVAC blocks (vertical +
 * intake + objection, joined exactly as resolveVerticalPromptSection does)
 * merged with a maxed-out training-asset section via
 * buildMergedVerticalVoicePrompt.
 */
function worstCaseVerticalSection(): string {
  const pack = createHvacPack();
  const canonicalPrompt = [
    formatVerticalForCallerPrompt(pack),
    formatIntakeQuestionsForPrompt(pack),
    formatObjectionScriptsForPrompt(pack),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');
  const trainingAssetPrompt = buildTrainingAssetPromptSection(
    Array.from({ length: MAX_PROMPT_ASSETS }, (_, i) => maxTrainingAsset(i)),
  );
  const merged = buildMergedVerticalVoicePrompt({ canonicalPrompt, trainingAssetPrompt });
  return `Tenant vertical context (use ONLY for entity recognition; do not change the JSON output schema):\n${merged}`;
}

describe('classifier prompt budget — per-profile first turn', () => {
  const cases: Array<{ profile: ClassifierProfile; sections: string[] }> = [
    // Live telephony always appends customer protection for callers.
    { profile: 'caller', sections: [CUSTOMER_PROTECTION_PROMPT_SECTION] },
    // field_tech gets no sections at all.
    { profile: 'field_tech', sections: [] },
  ];

  it.each(cases)(
    '$profile worst first turn (prompt + sections + full HVAC pack + max training assets + utterance) fits the per-turn budget with 15% margin',
    ({ profile, sections }) => {
      const firstTurn =
        buildClassifierSystemPrompt(profile) +
        sections.join('') +
        worstCaseVerticalSection() +
        SAMPLE_UTTERANCE;
      const tokens = estimateTokens(firstTurn);
      // Measured 2026-08-28 (#902): caller ≈ 7,004 tok, field_tech ≈ 6,802,
      // vs the 85% line of 9,000 × 0.85 = 7,650 — ≥5% real slack on both,
      // against a ceiling every term of which is bounded by code.
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
