/**
 * Phase 4d-1 perception skill — `classify-urgency-tier`.
 *
 * Maps a customer's stated need to one of four urgency tiers using
 * the deterministic rules in `corpus/data/triage-rules.json`. Output
 * drives downstream routing: dispatch immediately, dispatch same-day,
 * book next-available, or — for TIER_1 — instruct the customer to
 * evacuate before dispatch.
 *
 * Why deterministic (regex match) and not LLM:
 *   - Predictability: the same utterance must classify the same way
 *     every time. Operators, dispatchers, and customers depend on
 *     consistent triage. An LLM is a poor fit when the consequence of
 *     getting it wrong is "we didn't dispatch on a gas leak."
 *   - Latency: classification runs on the customer's first
 *     post-greeting utterance. Sub-100ms is the goal; a network LLM
 *     call is 300-2000ms.
 *   - Auditability: matched-phrase output lets ops humans review WHY
 *     a tier was assigned. "The model thought so" doesn't survive a
 *     post-incident review.
 *
 * The trade-off is recall: phrases that don't match any rule fall
 * through to TIER_4_SCHEDULE (no urgency). That's the conservative
 * direction for non-emergencies; for emergencies that the rule set
 * misses, the safety net is the FSM's existing `emergency_dispatch`
 * intent + dispatcher review on every appointment. A future Phase 4d-2
 * variant may add an LLM fallback for non-matched utterances, gated
 * on whether the regex rules prove insufficient in production.
 *
 * Layered evaluation order:
 *   1. False-positive guards FIRST — if a phrase that LOOKS like an
 *      emergency is actually benign in context (heat-pump defrost
 *      mistaken for steam from a fire), return TIER_4 + clarification
 *      recommendation rather than dispatching unnecessarily.
 *   2. Multi-fixture rule — multiple drains affected simultaneously
 *      reclassifies to a main-line issue and escalates to TIER_3
 *      minimum.
 *   3. Tier phrases from TIER_1 (highest) to TIER_4 (lowest); first
 *      match wins.
 *   4. Conditional phrases inside each tier — a base phrase plus a
 *      context modifier ("no heat" + winter). Context attributes are
 *      caller-provided (outdoor_temp, indoor_temp, elderly, infant,
 *      medical_equipment).
 *   5. Seasonal adjustments applied last as a non-decreasing escalator.
 */

import type {
  TriageRules,
  TierKey,
  ConditionalPhrase,
  FalsePositiveGuard,
} from './triage-rules.schema';

export type UrgencyTier = TierKey;

export interface UrgencyContext {
  /** Optional caller / location context. All fields optional — when
   *  absent, conditional rules that require them are skipped. */
  outdoorTempF?: number;
  indoorTempF?: number;
  /** Currently identifiable household risk attributes — drives no-AC
   *  escalation in summer, no-heat in winter, etc. */
  hasElderly?: boolean;
  hasInfant?: boolean;
  hasMedicalEquipment?: boolean;
  /** Coarse season label. Skill does not infer from temperature alone
   *  — caller passes this in (e.g. from a calendar lookup). */
  season?: 'winter' | 'spring' | 'summer' | 'fall' | 'spring_freeze_warning' | 'post_storm_power_outage';
  /** Single-family home flag — used by the no-hot-water rule. */
  isSingleFamilyHome?: boolean;
}

export interface UrgencyClassificationInput {
  utterance: string;
  context?: UrgencyContext;
}

export interface UrgencyClassification {
  tier: UrgencyTier;
  /** Substrings of the utterance that fired the classification. Empty
   *  when the result fell through to TIER_4_SCHEDULE without any rule
   *  match (the conservative default). */
  matchedPhrases: string[];
  /** Human-readable explanation for the audit trail. */
  rationale: string;
  /**
   * TRUE only for TIER_1. Means "instruct the customer to leave the
   * building before we dispatch a tech." The FSM uses this to switch
   * the response template into evacuation mode.
   */
  requiresEvacuation: boolean;
  /** Tier-defined response script when the data has one. */
  responseScript?: string;
  /** Set when the multi-fixture rule promoted this from a single-drain
   *  intent to a main-line job. */
  multiFixtureEscalation?: boolean;
  /** Set when a false-positive guard matched. Calling code SHOULD ask
   *  the customer the clarification before dispatching. */
  falsePositiveGuard?: {
    classification: string;
    clarification: string;
  };
}

const TIER_PRIORITY: Record<UrgencyTier, number> = {
  TIER_1_EVACUATE: 4,
  TIER_2_EMERGENCY_DISPATCH: 3,
  TIER_3_SAME_DAY_URGENT: 2,
  TIER_4_SCHEDULE: 1,
};

export function classifyUrgencyTier(
  input: UrgencyClassificationInput,
  rules: TriageRules,
): UrgencyClassification {
  const utterance = input.utterance.toLowerCase().trim();
  const ctx = input.context ?? {};

  // ── Step 1: false-positive guards. A phrase that looks like an
  // emergency may be benign in context. Run first so we don't escalate
  // before checking.
  const fpGuard = matchFalsePositiveGuard(utterance, rules.false_positive_guards, ctx);
  if (fpGuard) {
    return {
      tier: 'TIER_4_SCHEDULE',
      matchedPhrases: [fpGuard.trigger_phrase],
      rationale: `False-positive guard matched: ${fpGuard.classification}. ${fpGuard.action}`,
      requiresEvacuation: false,
      falsePositiveGuard: {
        classification: fpGuard.classification,
        clarification: fpGuard.response_script ?? fpGuard.action,
      },
    };
  }

  // ── Step 2: walk tiers high-to-low; collect the highest match.
  let bestTier: UrgencyTier | undefined;
  const matched: string[] = [];
  let tierResponseScript: string | undefined;

  for (const tierKey of TIER_ORDER) {
    const tierData = rules.trigger_words[tierKey];
    if (!tierData) continue;

    const tierMatched: string[] = [];
    for (const phrase of tierData.phrases ?? []) {
      if (utterance.includes(phrase.toLowerCase())) {
        tierMatched.push(phrase);
      }
    }
    for (const cond of tierData.conditional_phrases ?? []) {
      if (utterance.includes(cond.phrase.toLowerCase())) {
        const resolved = resolveConditionalTier(cond, ctx);
        if (resolved && (!bestTier || TIER_PRIORITY[resolved] > TIER_PRIORITY[bestTier])) {
          bestTier = resolved;
          matched.push(cond.phrase);
          tierResponseScript = rules.trigger_words[resolved]?.response_script;
        }
      }
    }
    if (tierMatched.length > 0) {
      if (!bestTier || TIER_PRIORITY[tierKey] > TIER_PRIORITY[bestTier]) {
        bestTier = tierKey;
        matched.length = 0;
        matched.push(...tierMatched);
        tierResponseScript = tierData.response_script;
      } else if (bestTier === tierKey) {
        matched.push(...tierMatched);
      }
    }
  }

  // ── Step 3: multi-fixture rule. If the utterance matches multi-drain
  // detection phrases, escalate to TIER_3 minimum.
  let multiFixtureEscalation = false;
  if (rules.multi_fixture_rule) {
    for (const phrase of rules.multi_fixture_rule.detection_phrases ?? []) {
      if (utterance.includes(phrase.toLowerCase())) {
        multiFixtureEscalation = true;
        matched.push(phrase);
        if (!bestTier || TIER_PRIORITY[bestTier] < TIER_PRIORITY['TIER_3_SAME_DAY_URGENT']) {
          bestTier = 'TIER_3_SAME_DAY_URGENT';
          tierResponseScript = rules.trigger_words['TIER_3_SAME_DAY_URGENT']?.response_script;
        }
        break;
      }
    }
  }

  // ── Step 4: seasonal adjustments. Apply only as a non-decreasing
  // escalator (we never DOWN-grade based on season).
  const seasonalEscalation = applySeasonalAdjustments(bestTier, ctx, utterance, rules);
  if (
    seasonalEscalation &&
    (!bestTier || TIER_PRIORITY[seasonalEscalation] > TIER_PRIORITY[bestTier])
  ) {
    bestTier = seasonalEscalation;
    tierResponseScript = rules.trigger_words[seasonalEscalation]?.response_script;
  }

  // ── Step 5: default to TIER_4 (no urgency escalation needed).
  const finalTier = bestTier ?? 'TIER_4_SCHEDULE';
  const requiresEvacuation = finalTier === 'TIER_1_EVACUATE';

  return {
    tier: finalTier,
    matchedPhrases: matched,
    rationale: buildRationale(finalTier, matched, multiFixtureEscalation),
    requiresEvacuation,
    ...(tierResponseScript ? { responseScript: tierResponseScript } : {}),
    ...(multiFixtureEscalation ? { multiFixtureEscalation } : {}),
  };
}

const TIER_ORDER: UrgencyTier[] = [
  'TIER_1_EVACUATE',
  'TIER_2_EMERGENCY_DISPATCH',
  'TIER_3_SAME_DAY_URGENT',
  'TIER_4_SCHEDULE',
];

function matchFalsePositiveGuard(
  utterance: string,
  guards: readonly FalsePositiveGuard[] | undefined,
  ctx: UrgencyContext,
): FalsePositiveGuard | undefined {
  if (!guards) return undefined;
  for (const guard of guards) {
    if (!utterance.includes(guard.trigger_phrase.toLowerCase())) continue;
    if (guardContextMatches(guard.context, ctx)) {
      return guard;
    }
  }
  return undefined;
}

function guardContextMatches(guardContext: string, ctx: UrgencyContext): boolean {
  // Free-form context strings like "winter / cold weather" or "first
  // time turning on furnace for the season". We don't try to fully
  // parse them — match the most common context tokens.
  const lowered = guardContext.toLowerCase();
  if (lowered.includes('winter') || lowered.includes('cold weather')) {
    if (ctx.season === 'winter') return true;
    if (ctx.outdoorTempF !== undefined && ctx.outdoorTempF < 40) return true;
    return false;
  }
  if (lowered.includes('first time turning on furnace')) {
    return ctx.season === 'fall' || ctx.season === 'winter';
  }
  // Conservative default: only match if NO specific context required.
  return guardContext.trim().length === 0;
}

function resolveConditionalTier(
  cond: ConditionalPhrase,
  ctx: UrgencyContext,
): UrgencyTier | undefined {
  if (cond.condition === 'any') {
    return cond.escalate_to;
  }
  // Free-form condition expressions like "outdoor_temp_below_40f OR
  // indoor_temp_below_55f" or "outdoor_temp_above_90f AND (elderly OR
  // infant OR medical_equipment_in_home)". Evaluate the small set of
  // expressions actually used in the JSON.
  const matched = evaluateCondition(cond.condition, ctx);
  if (matched) return cond.escalate_to;
  return cond.otherwise;
}

function evaluateCondition(expression: string, ctx: UrgencyContext): boolean {
  const expr = expression.toLowerCase();
  // Tokenize on AND/OR and parens — tiny custom evaluator that handles
  // exactly the operator forms used in the seeded rules JSON. If the
  // rules grow more complex we replace this with a real expression
  // parser, but for v1 a hand-rolled walker is honest about its scope.

  // Simple OR sequences
  if (expr.includes(' or ') && !expr.includes(' and ')) {
    return expr.split(' or ').some((part) => evaluateAtom(part.trim(), ctx));
  }
  // Simple AND sequences with optional parenthesised OR group
  if (expr.includes(' and ')) {
    const parts = splitTopLevelAnd(expr);
    return parts.every((part) => {
      const inner = part.replace(/^\((.*)\)$/, '$1').trim();
      if (inner.includes(' or ')) {
        return inner.split(' or ').some((p) => evaluateAtom(p.trim(), ctx));
      }
      return evaluateAtom(inner, ctx);
    });
  }
  return evaluateAtom(expr, ctx);
}

function splitTopLevelAnd(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && expr.slice(i, i + 5).toLowerCase() === ' and ') {
      parts.push(buf.trim());
      buf = '';
      i += 4;
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function evaluateAtom(atom: string, ctx: UrgencyContext): boolean {
  const a = atom.trim().toLowerCase();
  // Temperature predicates
  const tempBelow = a.match(/^outdoor_temp_below_(\d+)f$/);
  if (tempBelow) return ctx.outdoorTempF !== undefined && ctx.outdoorTempF < Number(tempBelow[1]);
  const tempAbove = a.match(/^outdoor_temp_above_(\d+)f$/);
  if (tempAbove) return ctx.outdoorTempF !== undefined && ctx.outdoorTempF > Number(tempAbove[1]);
  const indoorBelow = a.match(/^indoor_temp_below_(\d+)f$/);
  if (indoorBelow) return ctx.indoorTempF !== undefined && ctx.indoorTempF < Number(indoorBelow[1]);

  // Boolean attributes
  if (a === 'elderly') return ctx.hasElderly === true;
  if (a === 'infant') return ctx.hasInfant === true;
  if (a === 'medical_equipment_in_home') return ctx.hasMedicalEquipment === true;
  if (a === 'single_family_home') return ctx.isSingleFamilyHome === true;
  if (a === 'winter') return ctx.season === 'winter';
  if (a === 'summer') return ctx.season === 'summer';

  return false;
}

function applySeasonalAdjustments(
  currentTier: UrgencyTier | undefined,
  ctx: UrgencyContext,
  utterance: string,
  rules: TriageRules,
): UrgencyTier | undefined {
  if (!rules.seasonal_adjustments || !ctx.season) return undefined;
  const matchingRule = rules.seasonal_adjustments.find((r) => r.season === ctx.season);
  if (!matchingRule) return undefined;
  const ruleText = matchingRule.rule.toLowerCase();

  // Frozen pipe rule — escalate to TIER_2 for any frozen pipe mention.
  if (
    ctx.season === 'spring_freeze_warning' &&
    /frozen pipe|pipes froze/i.test(utterance)
  ) {
    return 'TIER_2_EMERGENCY_DISPATCH';
  }
  // Post-storm: HVAC won't-turn-on (or other low-urgency) → TIER_3.
  // Includes the case where the tier hasn't been resolved yet (no rule
  // matched) — `won't turn on` isn't in the seeded TIER_4 phrases, so
  // currentTier is undefined at this point.
  if (
    ctx.season === 'post_storm_power_outage' &&
    /(won'?t turn on|won'?t start|wont turn on)/i.test(utterance) &&
    (currentTier === undefined || currentTier === 'TIER_4_SCHEDULE')
  ) {
    return 'TIER_3_SAME_DAY_URGENT';
  }
  // Generic winter no-heat / summer no-AC rules are already handled
  // by conditional_phrases; the seasonal block is documentation.
  void ruleText;
  return undefined;
}

function buildRationale(
  tier: UrgencyTier,
  matched: string[],
  multiFixture: boolean,
): string {
  if (tier === 'TIER_4_SCHEDULE' && matched.length === 0) {
    return 'No urgency triggers matched; classified as routine schedule.';
  }
  const phraseList = matched.slice(0, 3).join('", "');
  const base = `Matched on phrases: "${phraseList}".`;
  return multiFixture
    ? `${base} Multi-fixture rule promoted to ${tier}.`
    : `${base} Classified as ${tier}.`;
}
