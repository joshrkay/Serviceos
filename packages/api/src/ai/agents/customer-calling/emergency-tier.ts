/**
 * ANS-001 — caller-safety tier classification for the S1 answering surface.
 *
 * The inbound agent must route a hazard by its LIFE-SAFETY nature, not by a
 * single binary "is this an emergency" bit. This maps a caller utterance onto
 * the goal's three tiers:
 *
 *   E1 = life safety (gas/CO/fire/smoke/electrical/injury) — evacuate/911; NEVER book
 *   E2 = urgent (flooding/burst/sewage/no-heat-in-cold/no-cool/…) — dispatcher / same-day
 *   E3 = routine — normal booking flow
 *
 * DESIGN — why the E1 table is embedded in code (not loaded from
 * corpus/data/triage-rules.json):
 *   The runtime Docker image ships ONLY packages/api/dist; the corpus data
 *   file is not present at runtime. A life-safety classifier must never depend
 *   on loading an absent file, so the E1 table lives in code here — mirroring
 *   emergency-detector.ts, which already embeds its keyword table for exactly
 *   this reason. The richer `classifyUrgencyTier` engine (+ triage-rules.json)
 *   stays available as an OPTIONAL enrichment (`rules` arg) for tests, eval,
 *   and any environment that bundles the corpus; the embedded set is
 *   authoritative at runtime.
 *
 * Load-bearing invariant (goal §3 — "Any ambiguity resolves upward in tier,
 * always. A false positive costs one unnecessary transfer. A false negative
 * can cost a life."): the final tier is the MAX of every signal. A keyword hit
 * can be upgraded to E1 but is never downgraded below E2 by a guard.
 */
import {
  classifyUrgencyTier,
  type UrgencyContext,
} from '../../skills/classify-urgency-tier';
import type { TriageRules } from '../../skills/triage-rules.schema';
import { detectEmergency, type EmergencyLanguage } from './emergency-detector';

export type SafetyTier = 'E1' | 'E2' | 'E3';

/**
 * PLACEHOLDER E1 script — NOT deployment-final. Goal §3 is categorical: the
 * actual words spoken to a caller reporting a gas leak must be sourced by
 * someone with trade + legal standing, "not by us, and not by a model." This
 * string exists only so the ROUTING is testable end to end; it leads with the
 * universal 911 direction as a fail-safe interim.
 *
 * The injection seam for the reviewed script is the `responseScript` field on
 * the `emergency_detected` event: a per-tenant reviewed script (from voice
 * config) is passed there and overrides this default with no code change.
 * Deployment tooling should gate on `E1_SCRIPT_REVIEW_REQUIRED`.
 *
 * #1056 — there is NO Spanish E1 script. A Spanish hazard report is E1 and
 * hears THIS script (911 first, then the evacuation direction) and the call
 * hangs up: safer than the E2 dispatcher hand-off it used to get. The Spanish
 * text must be sourced with the same standing (decision O-2), not written here.
 */
export const LIFE_SAFETY_E1_SCRIPT =
  'If anyone is in immediate danger, hang up and call 911 now. ' +
  'If you smell gas or suspect carbon monoxide, please leave the building ' +
  'immediately without using light switches or your phone inside, then call ' +
  '911 and your gas company once you are safely outside. ' +
  "I'm flagging this for immediate follow-up.";

/**
 * TRUE until a qualified-review E1 script is sourced and wired per tenant.
 * A production readiness gate should assert this is handled (reviewed script
 * configured) before go-live — the routing is built; the words are not signed off.
 */
export const E1_SCRIPT_REVIEW_REQUIRED = true;

/**
 * Embedded E1 life-safety phrase table — the runtime-authoritative source.
 * Word-bounded to avoid substring false positives; bare "smoke"/"fire" are
 * deliberately excluded ("smoke detector low battery", "fireplace") in favour
 * of phrase-level triggers. Injury phrasing is intentionally broad — per the
 * goal an unnecessary transfer is cheap, a missed injury is not.
 */
/**
 * Acute physical hazards. These are E1 regardless of tense/framing — "there was
 * a gas leak" still warrants caution, and disambiguating tense on a gas/fire
 * report is not worth the risk of a miss.
 */
export const E1_HAZARD_PHRASES: ReadonlyArray<string> = [
  // Gas
  'smell gas', 'smells like gas', 'gas smell', 'rotten eggs', 'sulfur smell',
  'gas leak', 'leaking gas',
  // Carbon monoxide
  'carbon monoxide', 'co detector', 'co alarm',
  // Fire / smoke (phrase-level — bare "fire"/"smoke"/"flames" too ambiguous:
  // "the flames on my furnace are yellow" is a routine diagnostic call)
  'on fire', 'caught fire', 'house fire', 'there is a fire', "there's a fire",
  'seeing flames', 'there are flames', 'smell smoke', 'smells like smoke',
  'smoke coming', 'smoke in the house', 'full of smoke', 'filling with smoke',
  // Electrical
  'electrical burning', 'burning wires', 'wires are burning', 'burning plastic',
  'sparking', 'sparks coming', 'outlet is sparking', 'panel is sparking',
  'breaker is sparking', 'wires sparking', 'sparks from', 'sparks near',
];

/**
 * #1056 — Spanish acute hazards, category for category with
 * {@link E1_HAZARD_PHRASES}. Before this table a Spanish gas leak only hit the
 * `detectEmergency` backstop, which is E2: the caller got the dispatcher line,
 * the call stayed open and a drafted booking stayed live.
 *
 * Phrase-level like the English table, so every entry names a hazard. Bare
 * "fuego"/"humo"/"llamas"/"chispas"/"incendio" are left out:
 * - "las llamas del calentador están amarillas" is a routine diagnostic call.
 * - "la alarma de incendio" is an inspection.
 * - "olor a quemado" stays E2, the same as English "burning smell".
 * "hay fuego" / "hay llamas" (there is a fire / there are flames) are left out
 * too. Spanish negation keeps them whole: "no hay fuego en el piloto" is a
 * routine no-flame repair call, while English "there is no fire" never
 * contains "there is a fire". An E1 false positive hangs up on the customer.
 * Phrases whose English twin carries the same negation risk ("sparks from",
 * "seeing flames") are mirrored, the same way the English table accepts them.
 * Unaccented variants are listed because STT drops diacritics. Matched with
 * Unicode-aware word edges (see `compileUnicode`).
 */
export const E1_HAZARD_PHRASES_ES: ReadonlyArray<string> = [
  // Gas
  'fuga de gas', 'escape de gas', 'huele a gas', 'olor a gas', 'olor de gas',
  'huevo podrido', 'huevos podridos', 'olor a azufre', 'huele a azufre',
  // Carbon monoxide
  'monóxido de carbono', 'monoxido de carbono',
  'detector de monóxido', 'detector de monoxido', 'alarma de monóxido', 'alarma de monoxido',
  // Fire / smoke
  'hay un incendio', 'tenemos un incendio', 'se incendió', 'se incendio',
  'se está incendiando', 'se esta incendiando', 'en llamas',
  'se prendió fuego', 'se prendio fuego', 'agarró fuego', 'agarro fuego',
  'veo llamas', 'salen llamas', 'saliendo llamas',
  'huele a humo', 'olor a humo', 'sale humo', 'saliendo humo', 'humo en la casa',
  'lleno de humo', 'llena de humo', 'llenando de humo',
  // Electrical
  'cables quemándose', 'cables quemandose',
  'se están quemando los cables', 'se estan quemando los cables',
  'plástico quemado', 'plastico quemado',
  'echando chispas', 'echa chispas', 'saltan chispas', 'saltando chispas',
  'salen chispas', 'saliendo chispas', 'chispas del', 'chispas de la', 'chispas cerca',
];

/**
 * Injury / medical-event phrasing. E1 by default (broad on purpose — a missed
 * injury can cost a life), BUT suppressed when the report is CLEARLY past or
 * hypothetical with no present-tense urgency (see the guards below), so
 * "the old shed collapsed years ago" does not trigger a 911 direction. Anything
 * ambiguous stays E1 — the goal's asymmetric bias resolves upward.
 */
export const E1_INJURY_PHRASES: ReadonlyArray<string> = [
  'not breathing', "isn't breathing", 'is not breathing', 'stopped breathing',
  "won't wake up", 'not waking up', 'unconscious', 'unresponsive',
  'passed out', 'electrocuted', 'got shocked', 'electric shock',
  'someone is hurt', 'someone got hurt', "someone's hurt", 'somebody got hurt',
  'someone is injured', 'badly burned', 'severe burn', 'heart attack',
  'chest pain', 'chest pains', 'seizure',
];

/**
 * "collapsed" is a trade homonym ("my sewer line collapsed" is a routine,
 * high-value plumbing complaint) — an E1 false positive now costs the entire
 * call (911 script, hangup, booking revocation, owner emergency SMS), so the
 * bare word is not in the phrase table. It is E1 only with a person subject.
 */
const COLLAPSED_PERSON_RE =
  /\b(?:someone|somebody|anybody|he|she|they|my\s+(?:husband|wife|son|daughter|mom|dad|mother|father|kid|child|baby|brother|sister|friend|neighbor|roommate|tenant|grandma|grandpa|grandmother|grandfather|coworker|worker|guy|customer))\s+(?:(?:has|had|is|was|just)\s+){0,2}collapsed\b/i;

/** Kept for callers/tests that want the full E1 vocabulary. */
export const LIFE_SAFETY_E1_PHRASES: ReadonlyArray<string> = [
  ...E1_HAZARD_PHRASES,
  ...E1_HAZARD_PHRASES_ES,
  ...E1_INJURY_PHRASES,
];

/** Clearly past / hypothetical framing — a non-acute injury report. */
const PAST_OR_HYPOTHETICAL_RE =
  /\b(?:years?|months?|weeks?|days?)\s+ago\b|\blast\s+(?:year|month|week)\b|\bused to\b|\bin the past\b|\bhistory of\b|\ba while (?:back|ago)\b|\bif\s+(?:someone|somebody|anyone|anybody)\b|\bwhat if\b/i;
/** Present-tense urgency that OVERRIDES a past/hypothetical marker → stays E1. */
const PRESENT_URGENCY_RE =
  /\b(?:now|just|right now|currently|happening|help|hurry|911)\b|\b(?:is|isn'?t|not)\s+breathing\b|\b(?:he|she|they|someone|somebody)(?:'s| is| just)\b/i;

function compile(phrases: ReadonlyArray<string>) {
  return phrases.map((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { keyword: kw, regex: new RegExp(`\\b${escaped}\\b`, 'i') };
  });
}
/**
 * Unicode-aware word edges for the Spanish table. JS `\b` is ASCII-only, so a
 * phrase with an accented edge ("se incendió") would never match. Same
 * lookarounds as `emergency-detector.ts`. The English tables keep `\b`
 * byte-for-byte.
 */
function compileUnicode(phrases: ReadonlyArray<string>) {
  return phrases.map((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      keyword: kw,
      regex: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu'),
    };
  });
}
const HAZARD_REGEXES = compile(E1_HAZARD_PHRASES);
const HAZARD_REGEXES_ES = compileUnicode(E1_HAZARD_PHRASES_ES);
const INJURY_REGEXES = compile(E1_INJURY_PHRASES);

/** Pure, synchronous, free — the embedded E1 life-safety scan. */
export function detectLifeSafetyE1(
  transcript: string,
): { matched: boolean; keyword?: string; language?: EmergencyLanguage } {
  // Acute hazards: always E1.
  for (const { keyword, regex } of HAZARD_REGEXES) {
    if (regex.test(transcript)) return { matched: true, keyword, language: 'en' };
  }
  for (const { keyword, regex } of HAZARD_REGEXES_ES) {
    if (regex.test(transcript)) return { matched: true, keyword, language: 'es' };
  }
  // Injury: E1 unless clearly past/hypothetical AND no present-tense urgency.
  const clearlyNonAcute =
    PAST_OR_HYPOTHETICAL_RE.test(transcript) && !PRESENT_URGENCY_RE.test(transcript);
  if (!clearlyNonAcute) {
    for (const { keyword, regex } of INJURY_REGEXES) {
      if (regex.test(transcript)) return { matched: true, keyword, language: 'en' };
    }
    if (COLLAPSED_PERSON_RE.test(transcript)) {
      return { matched: true, keyword: 'collapsed', language: 'en' };
    }
  }
  return { matched: false };
}

/**
 * FIX 10(iii) — embedded E2 urgent-dispatch phrase table. Same rationale as
 * the E1 table above: corpus/data/triage-rules.json's TIER_2/TIER_3 phrases
 * are NOT shipped in the runtime image, so without an embedded set they are
 * dead weight outside a test/eval run that passes `rules`. This is
 * deliberately NOT a full parity table with TIER_2/TIER_3 (those stay
 * broader by design) — it pins only the specific corpus additions that had
 * no runtime equivalent at all ("sewage is backing up into the house" and a
 * fully-out AC classified E3 before this). Word-bounded like the E1 table.
 */
export const E2_URGENT_PHRASES: ReadonlyArray<string> = [
  'sewage backing up',
  'sewage is backing up',
  'sewage backing up into',
  'ac is out',
  'ac is completely out',
  'air conditioner is out',
  'no cooling',
];
const E2_REGEXES = compile(E2_URGENT_PHRASES);

/** Pure, synchronous, free — the embedded E2 urgent-dispatch scan. */
export function detectEmbeddedE2(
  transcript: string,
): { matched: boolean; keyword?: string } {
  for (const { keyword, regex } of E2_REGEXES) {
    if (regex.test(transcript)) return { matched: true, keyword };
  }
  return { matched: false };
}

export interface SafetyClassification {
  /** E1 = life safety (evacuate, never book), E2 = urgent, E3 = routine. */
  tier: SafetyTier;
  /** True only for E1. Switches the response into evacuation/safety-direct mode. */
  requiresEvacuation: boolean;
  /** Primary phrase/keyword that drove the classification (audit, non-PII). */
  keyword: string;
  /** Reviewed spoken script for E1, else null. */
  responseScript: string | null;
  /** Which layer decided the final tier — for post-incident review. */
  source: 'embedded' | 'engine' | 'backstop' | 'none';
  /**
   * #1056 — the language of the matched phrase, when a phrase table decided
   * the tier. A Spanish phrase is the strongest sign the caller speaks Spanish.
   * It rides the E1 audit row so a follow-up knows the caller heard the
   * English script (no Spanish E1 script exists yet, O-2).
   */
  language?: EmergencyLanguage;
}

const RANK: Record<SafetyTier, number> = { E1: 3, E2: 2, E3: 1 };

export type { UrgencyContext };

/**
 * Classify a caller utterance's safety tier. `rules` is OPTIONAL — when
 * omitted (the runtime hot path) only the embedded E1 table + `detectEmergency`
 * backstop are used; when provided, the richer `classifyUrgencyTier` engine
 * (vulnerability/seasonal amplifiers, wider E2 recall) is consulted too. The
 * final tier is always the strongest signal (upward-only bias, goal §3).
 */
export function classifyCallerSafety(
  utterance: string,
  ctx: UrgencyContext,
  rules?: TriageRules,
): SafetyClassification {
  const e1 = detectLifeSafetyE1(utterance);
  const embeddedE2 = detectEmbeddedE2(utterance);
  const backstop = detectEmergency(utterance);
  const engine = rules ? classifyUrgencyTier({ utterance, context: ctx }, rules) : null;

  let engineTier: SafetyTier | null = null;
  if (engine) {
    switch (engine.tier) {
      case 'TIER_1_EVACUATE':
        engineTier = 'E1';
        break;
      case 'TIER_2_EMERGENCY_DISPATCH':
      case 'TIER_3_SAME_DAY_URGENT':
        engineTier = 'E2';
        break;
      case 'TIER_4_SCHEDULE':
        engineTier = 'E3';
        break;
      default:
        // AMBIGUOUS_NEEDS_CLARIFICATION — no escalation signal from the engine.
        engineTier = null;
    }
  }

  // Build the candidate signals and take the strongest (E1 > E2 > E3).
  const candidates: Array<{
    tier: SafetyTier;
    source: SafetyClassification['source'];
    keyword?: string;
    script?: string | null;
    language?: EmergencyLanguage;
  }> = [];
  if (e1.matched)
    candidates.push({
      tier: 'E1',
      source: 'embedded',
      keyword: e1.keyword,
      // #1056 — the backstop's detected language is carried into the E1
      // candidate: Spanish anywhere in the hit means a Spanish speaker.
      language: e1.language === 'es' || backstop.language === 'es' ? 'es' : e1.language,
    });
  if (engineTier === 'E1')
    candidates.push({
      tier: 'E1',
      source: 'engine',
      keyword: engine!.matchedPhrases[0],
      script: engine!.responseScript ?? null,
    });
  if (engineTier === 'E2')
    candidates.push({ tier: 'E2', source: 'engine', keyword: engine!.matchedPhrases[0] });
  if (embeddedE2.matched)
    candidates.push({
      tier: 'E2',
      source: 'embedded',
      keyword: embeddedE2.keyword,
      language: 'en',
    });
  if (backstop.matched)
    candidates.push({
      tier: 'E2',
      source: 'backstop',
      keyword: backstop.keyword,
      ...(backstop.language ? { language: backstop.language } : {}),
    });
  if (engineTier === 'E3') candidates.push({ tier: 'E3', source: 'engine' });

  if (candidates.length === 0) {
    return {
      tier: 'E3',
      requiresEvacuation: false,
      keyword: 'unknown',
      responseScript: null,
      source: 'none',
    };
  }

  candidates.sort((a, b) => RANK[b.tier] - RANK[a.tier]);
  const winner = candidates[0]!;
  // E1 speaks the same script whatever the language: there is no reviewed
  // Spanish E1 script (see LIFE_SAFETY_E1_SCRIPT, #1056).
  const responseScript =
    winner.tier === 'E1'
      ? (winner.script ?? LIFE_SAFETY_E1_SCRIPT)
      : (winner.script ?? null);

  return {
    tier: winner.tier,
    requiresEvacuation: winner.tier === 'E1',
    keyword: winner.keyword ?? 'unknown',
    responseScript,
    source: winner.source,
    ...(winner.language ? { language: winner.language } : {}),
  };
}

// ─── Boot-time readiness gate (FIX 10i) ───────────────────────────────────────

export interface E1ScriptReadiness {
  /** False while the embedded placeholder is still in effect (deployment gate). */
  ready: boolean;
  /** Prominent, human-readable status for a structured boot log. */
  message: string;
}

/**
 * Pure, synchronous boot-time readiness check. This is the ONE consumer of
 * `E1_SCRIPT_REVIEW_REQUIRED` — without it the constant was declared but
 * never read, so a placeholder life-safety script could ship to production
 * completely silently. `app.ts` calls this once at boot and logs the result;
 * per-tenant overrides ride `tenant_settings.e1_reviewed_script` (migration
 * 267) via the `emergency_detected.responseScript` seam — see
 * `runEmergencyScan` in `telephony/twilio-adapter.ts`.
 *
 * Deliberately pure/free of I/O so it can NEVER be the reason boot fails —
 * callers still wrap the call defensively, but this function itself cannot
 * throw.
 */
export function e1ScriptReadiness(): E1ScriptReadiness {
  if (!E1_SCRIPT_REVIEW_REQUIRED) {
    return {
      ready: true,
      message: 'E1 life-safety script has been marked reviewed (E1_SCRIPT_REVIEW_REQUIRED=false).',
    };
  }
  return {
    ready: false,
    message:
      'E1 life-safety script is an UNREVIEWED PLACEHOLDER (LIFE_SAFETY_E1_SCRIPT). ' +
      'It leads with a fail-safe 911 direction but has not been signed off by anyone with ' +
      'trade + legal standing. Configure a reviewed script per tenant via ' +
      'tenant_settings.e1_reviewed_script before go-live — every E1 call speaks the ' +
      'placeholder until then.',
  };
}
