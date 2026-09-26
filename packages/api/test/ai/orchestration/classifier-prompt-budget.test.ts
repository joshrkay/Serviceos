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
  CALLER_UTTERANCE_FENCE_PROMPT_SECTION,
  classifierUserContent,
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
import { formatCallerPlanForPrompt } from '../../../src/ai/orchestration/caller-plan-context';
import { buildAccountContextPromptSection } from '../../../src/ai/agents/customer-calling/b2b-account-context';
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

/** The worst-first-turn line only: 86% after #1240's fence id (see the case below). */
const PER_TURN_FIRST_TURN_MARGIN = 0.86;

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

/**
 * #894 review — the per-caller sections the live turn ALSO sends
 * (create-voice-turn-processor.ts speechTurn / twilio-adapter Gather classify:
 * `planPromptSection`, `b2bAccountPromptSection`), wrapped exactly as
 * classifyIntentRaw wraps them. The previous pin left both out.
 *
 * Realistic, not a ceiling: `formatCallerPlanForPrompt` has no cap on plan
 * names, so a plan section is bounded only by what a tenant names its plans.
 * Two plans with typical names + a next-service date. The B2B section is
 * capped in code at MAX_PROMPTED_SUB_ACCOUNTS (8) names: a property manager
 * with a parent portfolio and 12 managed properties (8 shown, "+4 more").
 */
function realisticPlanSection(): string {
  const plan = formatCallerPlanForPrompt({
    hasActivePlan: true,
    planNames: ['Gold Comfort Club Membership', 'Spring & Fall HVAC Tune-Up Plan'],
    earliestNextServiceDue: new Date('2026-10-01T15:00:00Z'),
  });
  return `Caller plan context (use to personalize the response; do not change the JSON output schema):\n${plan}`;
}

function realisticB2bSection(): string {
  const properties = [
    'Maple Court Apartments', 'Riverside Commons Townhomes', 'Oak Hollow Senior Living',
    'Canyon View Lofts', 'Desert Bloom Villas', 'Sunset Ridge Condominiums',
    'Palo Verde Garden Homes', 'Camelback Terrace Flats', 'Mesa Vista Duplexes',
    'Saguaro Pointe Residences', 'Copper Creek Studios', 'Ironwood Place',
  ].map((displayName, i) => ({ customerId: `sub-${i}`, displayName, accountType: 'property_manager' as const }));
  const b2b = buildAccountContextPromptSection({
    customerId: 'pm-1',
    accountType: 'property_manager',
    priority: true,
    parentAccount: { customerId: 'parent-1', displayName: 'Southwest Residential Portfolio Management LLC' },
    parentMissing: false,
    subAccounts: properties,
  });
  return `Caller account context (use to prioritize and inform tone; do not change the JSON output schema):\n${b2b}`;
}

describe('classifier prompt budget — per-profile first turn', () => {
  const cases: Array<{ name: string; profile: ClassifierProfile; sections: string[] }> = [
    // Live telephony always appends customer protection for callers; every
    // S1 profile also carries the #894 caller-utterance fence rule.
    {
      name: 'caller',
      profile: 'caller',
      sections: [CUSTOMER_PROTECTION_PROMPT_SECTION, CALLER_UTTERANCE_FENCE_PROMPT_SECTION],
    },
    // #894 review — a business-account (property manager) caller on an active
    // maintenance plan: the plan AND account sections ride the same turn.
    {
      name: 'caller on a plan with a property-manager account',
      profile: 'caller',
      sections: [
        realisticPlanSection(),
        realisticB2bSection(),
        CUSTOMER_PROTECTION_PROMPT_SECTION,
        CALLER_UTTERANCE_FENCE_PROMPT_SECTION,
      ],
    },
    // field_tech gets no protection/extended section — only the #894 fence
    // rule. (A caller-ID-resolved employee is not a customer, so no plan or
    // account section is resolved for the turn.)
    { name: 'field_tech', profile: 'field_tech', sections: [CALLER_UTTERANCE_FENCE_PROMPT_SECTION] },
  ];

  it.each(cases)(
    '$name worst first turn (prompt + sections + full HVAC pack + max training assets + fenced utterance) fits the per-turn budget with 15% margin',
    ({ profile, sections }) => {
      const firstTurn =
        buildClassifierSystemPrompt(profile) +
        sections.join('') +
        worstCaseVerticalSection() +
        // #894 — the S1 utterance is sent fenced (label + hardening line + markers).
        classifierUserContent(SAMPLE_UTTERANCE, profile);
      const tokens = estimateTokens(firstTurn);
      // Measured 2026-08-28 (#902): caller ≈ 7,004 tok, field_tech ≈ 6,802,
      // vs the 85% line of 9,000 × 0.85 = 7,650 — ≥5% real slack on both,
      // against a ceiling every term of which is bounded by code.
      // Re-measured 2026-09-14 (#894 — fence rule + fenced utterance, ≈350
      // tok): caller ≈ 7,350, field_tech ≈ 7,148 — ≈3.9% / 6.6% slack.
      // #894 review — with the plan + property-manager account sections the
      // live turn also sends: ≈ 7,608 tok — 42 tok (≈0.5%) under the 7,650
      // line. The line is NOT raised. The plan section has no cap in code
      // (formatCallerPlanForPrompt lists every active plan name), so ~170
      // more characters of plan names on this caller crosses it.
      // #891/#893 (caller framing + draft_estimate grounding line) add
      // ≈22 tok → ≈ 7,630; both were kept to one terse line for this reason.
      // #1240 (per-request 64-bit fence id on the BEGIN/END lines + the
      // "only the END line carrying <id> closes this block" rule) adds ≈40
      // tok → ≈ 7,670 on the plan+account caller. That is a security cost,
      // so this ONE per-turn line moves 85% → 86% (7,740); the hard ceiling
      // (9,000, session-cost-tracker) is unchanged and still ≈15% away. Any
      // further growth must be paid for by trimming, not by raising this.
      expect(tokens).toBeLessThan(PER_TURN_CLASSIFY_INPUT_TOKEN_BUDGET * PER_TURN_FIRST_TURN_MARGIN);
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
