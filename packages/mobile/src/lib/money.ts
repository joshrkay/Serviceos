/**
 * Money input parsing for capture forms — the inverse of `formatMoneyCents`.
 *
 * The repo invariant is integer cents end to end (never float math on money).
 * Operators, though, type dollars ("1,240", "$85.50"), so a capture field has
 * to turn a human string into integer cents exactly once, at the edge, with no
 * floating-point drift. `parseDollarsToCents` does that and nothing else; the
 * cents it returns are the only number the rest of the app touches.
 *
 * Pure and framework-free — unit-tested directly.
 */

/**
 * Parse a dollars string into integer cents, or `null` when it isn't a valid
 * non-negative money amount.
 *
 * Accepts an optional leading `$`, thousands separators, and 0–2 decimal
 * places. Rejects negatives, >2 decimals, and anything non-numeric. Cents are
 * computed without float multiplication (`dollars * 100` drifts, e.g.
 * `85.55 * 100 === 8554.999…`): the whole and fractional parts are combined as
 * integers.
 */
export function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (trimmed === '') return null;
  // Whole dollars, or dollars with 1–2 decimal places. No sign, no exponent.
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const whole = Number(match[1]);
  // Pad a single decimal ("50" tenths → "50" cents; "5" → "50") to two places.
  const fraction = match[2] ? match[2].padEnd(2, '0') : '00';
  return whole * 100 + Number(fraction);
}
