/**
 * U4 (P2-036 V2) — Deterministic target-price parser.
 *
 * When a customer pushes on price, the guardrail
 * (src/proposals/guardrails/negotiation-guardrail.ts) already classifies the
 * *ask type* (discount / scope / refund / ...) with a fixed, auditable keyword
 * list. This module is its numeric counterpart: it extracts the concrete number
 * the customer named — "$200", "knock $50 off", "10% off" — into a structured
 * target the owner-callback flow can quote against, or marks the utterance
 * `ambiguous` so the caller routes a one-tap voice_clarification.
 *
 * PRECISION OVER RECALL (same stance as negotiation-guardrail.ts): this is pure
 * logic with no LLM and no I/O, so it must be exhaustively unit-testable and
 * conservative. We only return a typed target when the number sits in an
 * unmistakable money/percent context with NO competing interpretation; every
 * uncertain case (spoken word-numbers, no-number asks, conflicting numbers, a
 * bare number with no money cue) falls through to `ambiguous`. A wrong guess
 * here becomes a wrong quote to a customer; a clarification is cheap, so we
 * never guess.
 *
 * Money is integer cents; percentages are basis points (bps): 10% = 1000 bps.
 * Integer math only (dollars * 100 + cents) — no float drift.
 */

export type ParsedDiscountTarget =
  // "I'll pay $200", "200 dollars" — the price the customer wants to land on.
  | { kind: 'target_price'; requestedTargetCents: number }
  // "knock $50 off", "take $50 off" — a dollar reduction off the current price.
  | { kind: 'discount_amount'; requestedDiscountAmountCents: number }
  // "10% off", "10 percent off", "10 percent" — a proportional reduction.
  | { kind: 'discount_percent'; requestedDiscountBps: number }
  // No confident parse — caller routes to a voice_clarification.
  | { kind: 'ambiguous' };

const AMBIGUOUS: ParsedDiscountTarget = { kind: 'ambiguous' };

/**
 * Sanity cap on a dollar figure ($1,000,000). A residential service job that
 * fits this product is never six figures; a number above this is almost
 * certainly a misparse (a phone number, an address, a typo) and is rejected to
 * `ambiguous` rather than turned into an absurd quote.
 */
const MAX_REASONABLE_CENTS = 100_000_000; // $1,000,000.00

/** Basis-points bounds: a discount can't be negative or exceed 100%. */
const MAX_DISCOUNT_BPS = 10_000; // 100%

/**
 * Convert a matched dollar body (integer-part string with optional commas, plus
 * optional 2-digit cents string) to integer cents, or null if it is absent or
 * exceeds the sanity cap. Pure integer math.
 */
function dollarPartsToCents(intPart: string | undefined, centsPart: string | undefined): number | null {
  if (intPart == null) return null;
  const dollars = Number.parseInt(intPart.replace(/,/g, ''), 10);
  if (!Number.isFinite(dollars)) return null;
  const cents = centsPart != null ? Number.parseInt(centsPart, 10) : 0;
  const total = dollars * 100 + cents;
  if (total <= 0 || total > MAX_REASONABLE_CENTS) return null;
  return total;
}

// A money token is a `$`-prefixed figure OR a figure followed by dollars/bucks.
// Both forms are unambiguous money cues, so we count them as the same "number".
const MONEY_TOKEN = new RegExp(`(?:\\$\\d|\\d[\\d,]*(?:\\.\\d{2})?\\s*(?:dollars?|bucks?))`, 'gi');

// A percent token: a figure immediately followed by `%` or the word percent.
const PERCENT_TOKEN = /\d+(?:\.\d+)?\s*(?:%|percent)/gi;

// --- Branch matchers (anchored to an unambiguous context) ---

// "10% off", "10 percent off", "10 percent", "10%". Captures the integer
// percent; we deliberately reject fractional percents (e.g. "10.5%") to stay
// conservative — bps would round and the case is vanishingly rare in speech.
// No trailing \b: a literal "%" is a non-word char, so "10%" has no word
// boundary after it and a trailing \b would (wrongly) fail to match the symbol
// form. The leading \b plus the explicit %|percent already bound the capture.
const PERCENT_RX = /\b(\d{1,3})\s*(?:%|percent)/i;

// "knock/take/shave/cut [me] $50 off" — a reduction verb, then a dollar figure,
// then "off", with no sentence boundary crossed. The dollar figure here must be
// `$`-prefixed (a reduction is always stated in dollars on this path).
const DISCOUNT_AMOUNT_RX = new RegExp(
  `\\b(?:knock|take|shave|cut)\\b[^.?!]{0,20}?\\$(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{2}))?[^.?!]{0,12}?\\boff\\b`,
  'i',
);

// A target price: a single dollar figure stated as money. Either `$`-prefixed
// or suffixed with dollars/bucks. Anchored on the money cue so a bare number is
// never read as a price.
const TARGET_DOLLAR_PREFIXED_RX = new RegExp(`\\$(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{2}))?`, 'i');
const TARGET_DOLLAR_SUFFIXED_RX = new RegExp(
  `\\b(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{2}))?\\s*(?:dollars?|bucks?)\\b`,
  'i',
);

/**
 * Count distinct money + percent tokens. More than one means competing numbers
 * (e.g. "I paid $300 last time, take $50 off this one") — ambiguous by design,
 * because we can't be sure which number is the target without guessing.
 */
function countMoneyAndPercentTokens(text: string): number {
  const money = text.match(MONEY_TOKEN)?.length ?? 0;
  const pct = text.match(PERCENT_TOKEN)?.length ?? 0;
  return money + pct;
}

/**
 * Parse a customer's negotiation utterance into a structured target, or mark it
 * `ambiguous`. High precision: only an unmistakable single-number money/percent
 * statement yields a typed target; everything else is `ambiguous`.
 */
export function parseDiscountTarget(text: string): ParsedDiscountTarget {
  if (typeof text !== 'string') return AMBIGUOUS;
  const trimmed = text.trim();
  if (trimmed.length === 0) return AMBIGUOUS;

  // Conflicting numbers → ambiguous. Count money/percent tokens up front: if the
  // customer named more than one money/percent figure we can't pick the target
  // without guessing, so we bail before any branch.
  if (countMoneyAndPercentTokens(trimmed) > 1) return AMBIGUOUS;

  // 1) Percent: "10% off", "10 percent". Checked first so "10% off" never reads
  //    its bare "10" as a dollar amount.
  const pct = PERCENT_RX.exec(trimmed);
  if (pct) {
    const whole = Number.parseInt(pct[1], 10);
    if (!Number.isFinite(whole)) return AMBIGUOUS;
    const bps = whole * 100;
    if (bps < 0 || bps > MAX_DISCOUNT_BPS) return AMBIGUOUS;
    return { kind: 'discount_percent', requestedDiscountBps: bps };
  }

  // 2) Discount amount: "knock $50 off". A reduction verb + $figure + "off".
  const amt = DISCOUNT_AMOUNT_RX.exec(trimmed);
  if (amt) {
    const cents = dollarPartsToCents(amt[1], amt[2]);
    if (cents == null) return AMBIGUOUS;
    return { kind: 'discount_amount', requestedDiscountAmountCents: cents };
  }

  // 3) Target price: a single dollar figure stated as money ($-prefixed or
  //    "...dollars"/"...bucks"). A bare number with no money cue is NOT a price.
  const prefixed = TARGET_DOLLAR_PREFIXED_RX.exec(trimmed);
  const suffixed = TARGET_DOLLAR_SUFFIXED_RX.exec(trimmed);
  if (prefixed && suffixed) {
    // Both a "$" figure and a "...dollars" figure present but they describe the
    // same single token only if identical; otherwise treat as conflicting.
    const a = dollarPartsToCents(prefixed[1], prefixed[2]);
    const b = dollarPartsToCents(suffixed[1], suffixed[2]);
    if (a == null || b == null || a !== b) return AMBIGUOUS;
    return { kind: 'target_price', requestedTargetCents: a };
  }
  const money = prefixed ?? suffixed;
  if (money) {
    const cents = dollarPartsToCents(money[1], money[2]);
    if (cents == null) return AMBIGUOUS;
    return { kind: 'target_price', requestedTargetCents: cents };
  }

  // No money cue, no percent, no reduction phrase → ambiguous. This covers
  // spoken word-numbers ("two fifty", "a couple hundred"), no-number asks
  // ("match my last quote", "can you do better", "best price", "give me a
  // deal"), and a bare number with no money context.
  return AMBIGUOUS;
}
