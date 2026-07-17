/**
 * RV-140 — deterministic emergency keyword interrupt.
 *
 * Runs on EVERY caller transcript chunk (Gather finals and media-streams
 * finals) BEFORE any LLM call, mirroring the frustration detector pattern.
 * A match dispatches `emergency_detected` into the FSM, which fast-paths to
 * `escalating` with the 911 safety script (RV-142) spoken FIRST, then the
 * dispatcher transfer.
 *
 * Keyword table = PLATFORM DEFAULTS only. Deliberately conservative,
 * life-safety-shaped phrases — a false positive pulls a dispatcher off
 * another call, a false negative falls through to the LLM classifier's
 * emergency intent set (EMERGENCY_INTENTS), so this layer only needs to
 * catch the unambiguous phrasings deterministically and instantly.
 *
 * TODO(per-tenant keywords): per-tenant keyword merge is intentionally OUT
 * OF SCOPE here — the supervisor-policy track owns tenant policy storage.
 * When that lands, merge tenant additions into the compiled table at session
 * start (never remove platform defaults).
 */

/**
 * Single-phrase triggers: any one of these alone is an emergency.
 *
 * UB-C3 — the Spanish block is part of this SAME table and is therefore
 * scanned UNCONDITIONALLY on every call, regardless of the session's
 * language or the tenant's supported_languages opt-in: a Spanish speaker
 * on an 'English' call still says "fuga de gas", and the life-safety path
 * must fire either way. Unaccented variants are included because STT
 * transcripts frequently drop diacritics.
 */
/**
 * English single-phrase triggers.
 */
const ENGLISH_EMERGENCY_KEYWORDS: ReadonlyArray<string> = [
  // Gas
  'gas leak',
  'smell gas',
  'smells like gas',
  'leaking gas',
  // Carbon monoxide
  'carbon monoxide',
  // Fire / smoke (phrase-level — bare "fire" is too ambiguous)
  'on fire',
  'caught fire',
  'smell smoke',
  'smells like smoke',
  'smoke coming',
  // Water
  'flooding',
  'flooded',
  'burst pipe',
  'water everywhere',
  // Electrical
  'sparking',
  'sparks coming',
  'electrical burning',
  'burning smell',
  'burning wires',
];

/**
 * Spanish (UB-C3) single-phrase triggers — mirrors the English scope, always
 * active. Split into its own labeled block (rather than one flat list) so a
 * match can carry the caller's LANGUAGE: a Spanish emergency phrase is the
 * strongest available signal that the caller speaks Spanish, which the safety
 * line must be localized to (the accented-vowel / marker-word heuristics in
 * tts-copy / language-detector miss accent-less sentences like "hay una fuga
 * de gas en mi casa"). Unaccented variants are included because STT drops
 * diacritics.
 */
const SPANISH_EMERGENCY_KEYWORDS: ReadonlyArray<string> = [
  // Gas
  'fuga de gas',
  'escape de gas',
  'huele a gas',
  'olor a gas',
  // Carbon monoxide
  'monóxido de carbono',
  'monoxido de carbono',
  // Fire / smoke ("incendio" is a structure fire — unambiguous, unlike
  // bare English "fire")
  'incendio',
  'se está quemando',
  'se esta quemando',
  'en llamas',
  'huele a humo',
  'olor a humo',
  // Water
  'inundación',
  'inundacion',
  'inundado',
  'inundada',
  'tubería rota',
  'tuberia rota',
  'agua por todas partes',
  // Electrical
  'echando chispas',
  'olor a quemado',
  'cables quemándose',
  'cables quemandose',
  // General / medical — explicit platform-default additions for Spanish
  // callers ("emergencia" is a deliberate, unambiguous ask for urgency).
  'emergencia',
  'no puedo respirar',
  'no puede respirar',
  'no podemos respirar',
];

/**
 * Flat platform-default table, English then Spanish. Order preserved for any
 * consumer that relied on it (and the detector test that snapshots it).
 */
export const EMERGENCY_KEYWORDS: ReadonlyArray<string> = [
  ...ENGLISH_EMERGENCY_KEYWORDS,
  ...SPANISH_EMERGENCY_KEYWORDS,
];

/**
 * Compound trigger: a no-heat report is an emergency only when paired with a
 * freezing/at-risk-occupant phrase in the SAME chunk (matches the platform
 * default "no heat + freezing/infant phrasing").
 */
const ENGLISH_NO_HEAT_PHRASES: ReadonlyArray<string> = [
  'no heat',
  'heat is out',
  "heat's out",
  'heater is out',
  'heating is out',
  'furnace is out',
  'furnace died',
  'heater stopped',
];

// Spanish (UB-C3) — same compound gate, always active.
const SPANISH_NO_HEAT_PHRASES: ReadonlyArray<string> = [
  'no hay calefacción',
  'no hay calefaccion',
  'sin calefacción',
  'sin calefaccion',
  'la calefacción no funciona',
  'la calefaccion no funciona',
];

export const NO_HEAT_PHRASES: ReadonlyArray<string> = [
  ...ENGLISH_NO_HEAT_PHRASES,
  ...SPANISH_NO_HEAT_PHRASES,
];

export const NO_HEAT_RISK_PHRASES: ReadonlyArray<string> = [
  'freezing',
  'below zero',
  'pipes are frozen',
  'baby',
  'infant',
  'newborn',
  'elderly',
  // Spanish (UB-C3). "bebé"-without-accent is omitted: bare "bebe" is
  // also the verb "drinks", and the compound gate doesn't justify it.
  'congelando',
  'bajo cero',
  'tuberías congeladas',
  'tuberias congeladas',
  'bebé',
  'recién nacido',
  'recien nacido',
  'anciano',
  'anciana',
];

export type EmergencyLanguage = 'en' | 'es';

function compile(phrases: ReadonlyArray<string>, language: EmergencyLanguage) {
  return phrases.map((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // UB-C3 — unicode-aware word boundaries instead of `\b`: JS `\b` is
    // ASCII-only, so a phrase ENDING in an accented char (e.g. "bebé")
    // would never match ("é" is a non-word char to `\b`, and é→space is
    // then boundary-less). Lookarounds on letters/digits keep the exact
    // English semantics ("sparkling" still doesn't hit "sparking") while
    // making accented edges match.
    return {
      keyword: kw,
      language,
      regex: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu'),
    };
  });
}

// Compiled English-then-Spanish so match order is stable (English first).
const KEYWORD_REGEXES = [
  ...compile(ENGLISH_EMERGENCY_KEYWORDS, 'en'),
  ...compile(SPANISH_EMERGENCY_KEYWORDS, 'es'),
];
const NO_HEAT_REGEXES = [
  ...compile(ENGLISH_NO_HEAT_PHRASES, 'en'),
  ...compile(SPANISH_NO_HEAT_PHRASES, 'es'),
];
// Risk phrases don't drive language — the no-heat phrase's language governs.
const NO_HEAT_RISK_REGEXES = compile(NO_HEAT_RISK_PHRASES, 'en');

export interface EmergencyMatch {
  matched: boolean;
  /** First matched keyword (or the compound `"<no-heat>" + "<risk>"`). */
  keyword?: string;
  /**
   * Language of the matched keyword — the strongest per-call language signal
   * for localizing the safety line (a Spanish emergency phrase means the caller
   * speaks Spanish even when the surrounding sentence carries no accents/markers
   * the generic detectors key on). Undefined when nothing matched.
   */
  language?: EmergencyLanguage;
}

/** Pure, synchronous, free — safe to run on every transcript chunk. */
export function detectEmergency(transcript: string): EmergencyMatch {
  for (const { keyword, language, regex } of KEYWORD_REGEXES) {
    if (regex.test(transcript)) {
      return { matched: true, keyword, language };
    }
  }
  const noHeat = NO_HEAT_REGEXES.find(({ regex }) => regex.test(transcript));
  if (noHeat) {
    const risk = NO_HEAT_RISK_REGEXES.find(({ regex }) => regex.test(transcript));
    if (risk) {
      return {
        matched: true,
        keyword: `${noHeat.keyword} + ${risk.keyword}`,
        language: noHeat.language,
      };
    }
  }
  return { matched: false };
}

/**
 * RV-142 — safety script. Spoken FIRST on every emergency detection, before
 * any transfer/dial copy. Kept jurisdiction-simple on purpose: the platform
 * currently serves US tenants only (see compliance/jurisdiction.ts — the
 * jurisdiction module exposes US recording/quiet-hours flags and no
 * emergency-number variants), so 911 is the correct universal line. If a
 * non-US jurisdiction flag ever lands there, branch here.
 */
export const EMERGENCY_SAFETY_LINE =
  'If anyone is in immediate danger, hang up and call 911.';
