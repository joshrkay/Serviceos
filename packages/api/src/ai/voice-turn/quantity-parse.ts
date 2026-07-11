/**
 * WS17 (I1) — deterministic leading-quantity parser for spoken quote lines.
 *
 * The classifier emits line-item DESCRIPTIONS only (never a price, never a
 * structured quantity — changing its prompt/schema would perturb the
 * voice-quality cassette hashes + gateway cache keys). But a caller very often
 * SAYS the count inline: "three smoke detectors", "2 gaskets". Grounding those
 * at quantity 1 under-quotes the total the caller hears. This module recovers
 * the quantity from the description text with a conservative, purely
 * deterministic heuristic — no LLM, no prompt change.
 *
 * The heuristic (see `parseLeadingQuantity`):
 *   - A leading count is a DIGIT ("3 smoke detectors") or a number WORD
 *     one–twelve ("three smoke detectors"), or the article "a"/"an" → 1.
 *   - It is a count ONLY when the remainder is non-empty AND does not begin
 *     with a UNIT token. "2 inch pipe fitting" — the "2" sizes the pipe, it is
 *     not a quantity — so it stays quantity 1 with the FULL original
 *     description. Same for "500 ft of wire", "5 gallon drum", etc.
 *   - A bare number word with no remainder ("two") stays a description at
 *     quantity 1 — we never strip when unsure.
 *
 * Match parity: `normalizeForMatch` (catalog-resolver) already drops
 * digit-only tokens and the "a"/"an"/"the" stopwords, so the tokens used for
 * catalog matching are IDENTICAL whether or not we strip the leading count —
 * only the quantity (→ the spoken total) changes. Pinned by a parity test.
 */

/** Number words we recognise as a leading count (one–twelve). */
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Upper bound on a parsed digit quantity. A larger leading number ("2026",
 * a model/part number a caller reads out) is treated as NOT a quantity — we
 * keep the full description at quantity 1 rather than emit an absurd count.
 */
export const MAX_PARSED_QUANTITY = 999;

/**
 * Unit / measurement tokens. When the token immediately AFTER a leading
 * number is one of these, the number is a SIZE or measure, not a count, so we
 * do not strip it. Kept deliberately broad (singular + plural + common
 * abbreviations) and lower-cased; matched against the first alphabetic run of
 * the remainder. Documented here so a future edit is a one-line change.
 */
const UNIT_TOKENS = new Set<string>([
  // length
  'inch', 'inches', 'in', 'ft', 'foot', 'feet', 'mm', 'cm', 'm', 'meter', 'meters',
  // volume
  'gallon', 'gallons', 'gal', 'ml', 'l', 'liter', 'liters', 'litre', 'litres', 'oz', 'ounce', 'ounces',
  // weight
  'lb', 'lbs', 'pound', 'pounds', 'kg', 'g', 'gram', 'grams', 'ton', 'tons',
  // electrical
  'amp', 'amps', 'volt', 'volts', 'v', 'watt', 'watts', 'w', 'kw',
  // hvac / plumbing / misc measures
  'btu', 'btus', 'hp', 'psi', 'gauge', 'ga', 'degree', 'degrees',
]);

export interface ParsedQuantity {
  /** Recovered count (≥ 1). Defaults to 1 when no leading count is present. */
  quantity: number;
  /**
   * The description to use for catalog matching. When a count was stripped
   * this is the trimmed remainder ("smoke detectors"); otherwise it is the
   * ORIGINAL string, unchanged, so non-quantity lines are byte-stable.
   */
  description: string;
}

/**
 * Parse a leading quantity from a spoken line-item description. Pure and
 * deterministic. See the module header for the full heuristic.
 */
export function parseLeadingQuantity(raw: string): ParsedQuantity {
  const trimmed = raw.trim();
  // Need at least "<head> <rest>" — a single token can't carry both a count
  // and a describable remainder.
  const match = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (!match) return { quantity: 1, description: raw };

  const head = match[1]!;
  const rest = match[2]!.trim();
  if (rest.length === 0) return { quantity: 1, description: raw };

  const headLower = head.toLowerCase();
  let qty: number | null = null;
  if (/^\d+$/.test(head)) {
    const n = Number.parseInt(head, 10);
    if (n >= 1 && n <= MAX_PARSED_QUANTITY) qty = n;
  } else if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, headLower)) {
    qty = NUMBER_WORDS[headLower]!;
  } else if (headLower === 'a' || headLower === 'an') {
    qty = 1;
  }
  if (qty === null) return { quantity: 1, description: raw };

  // Unit-token guard: "2 inch …", "5 gallon …" — the number measures, it does
  // not count. Keep the FULL original description at quantity 1.
  const firstRestToken = /^[a-z]+/.exec(rest.toLowerCase())?.[0];
  if (firstRestToken && UNIT_TOKENS.has(firstRestToken)) {
    return { quantity: 1, description: raw };
  }

  return { quantity: qty, description: rest };
}
