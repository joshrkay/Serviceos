/**
 * #909 (2026-08-31 live sweep, invoice INV-0022) — a price-scale guard for
 * AI-drafted line items.
 *
 * ## The bug this closes
 *
 * `draft_invoice` / `draft_estimate` (ai/tasks/invoice-task.ts,
 * estimate-task.ts) both ask their drafting LLM call for
 * `"unitPrice": <number>` with NO unit specified anywhere in the prompt —
 * the model is left to guess whether it means dollars or cents. Live
 * evidence from ONE invoice draft (utterance: "Draft an invoice for
 * <customer> for <job>, 450 dollars for the AC repair") shows the SAME
 * response getting it both ways:
 *   - "AC repair": unitPrice 450   -> stored as 450 CENTS ($4.50) — WRONG,
 *     the operator said $450.
 *   - "Diagnostic fee": unitPrice 79 -> stored as 79 CENTS ($0.79) — WRONG,
 *     plainly meant $79.
 *   - "filter line": unitPrice 7500 -> stored as 7500 CENTS ($75.00) —
 *     correct.
 *   - "Credit — repeat leak": unitPrice -5000 -> -$50.00 — correct.
 * Two lines in the identical response converted dollars->cents correctly;
 * two didn't. The model CAN do the conversion — the contract just never
 * tells it to, so it's a coin flip per line, not a one-time miss a prompt
 * example alone can be trusted to close (there is no cassette/mock test
 * that exercises the real model here — every task-handler test drives a
 * FIXED, mocked LLM response — so a prompt-only fix is not something this
 * module's tests can prove; the correction below runs on parsed JSON
 * output regardless of prompt wording, and IS deterministically testable).
 *
 * ## The fix: evidence-gated, not a blind floor
 *
 * CLAUDE.md: "All money: integer cents, never floating point." A blind
 * "if the price looks small, multiply by 100" heuristic would silently
 * break a GENUINE sub-dollar line (a real $0.79 fastener, say) that
 * happens to be legitimately cheap — CLAUDE.md's own catalog-resolver.ts
 * doc comment is explicit that money must never be guessed at, only
 * grounded. So this guard corrects a line's raw price ONLY when there is
 * direct, textual EVIDENCE in the drafting utterance itself that the
 * operator spoke that exact number as a whole-dollar amount — "$450" or
 * "450 dollars" appearing verbatim in `context.message`. A line whose
 * price is NOT separately echoed as a spoken dollar figure is left
 * completely alone, sub-dollar or not — the $0.79 part stays $0.79 unless
 * the utterance ALSO happens to say "79 dollars" for something, which
 * would be a real, and vanishingly unlikely, coincidence.
 *
 * Scoped to WHOLE-dollar mentions only (matches the exact bug shape
 * observed — an integer dollar count written straight into a cents
 * field). A fractional mention ("$12.50") is deliberately never treated
 * as evidence: it does not obviously correspond to any single raw integer
 * a naive LLM would emit (see `extractSpokenWholeDollarAmounts`'s own
 * doc comment for why splitting it would be unsafe), so a line priced
 * near a spoken fractional dollar amount is left for catalog grounding /
 * human review to sort out, same as before this guard existed.
 *
 * Even a false-positive correction here is bounded: `groundLineItemPricing`
 * (catalog-resolver.ts) still runs afterward and OVERWRITES any
 * catalog-matched line with the catalog's own authoritative price
 * regardless of what this guard did, and every line this guard COULD
 * affect is by definition uncatalogued (no catalog price to fall back
 * on) — which already forces the money-correctness confidence cap and
 * blocks auto-approval (UNCATALOGUED_CONFIDENCE_CAP, same file) — so a
 * human reviews the corrected number before it ever moves money, exactly
 * as they would have reviewed the wrong one.
 *
 * Pure and deterministic — no I/O, no LLM — same posture as the rest of
 * this resolution package.
 */

/**
 * Whole-dollar amounts spoken in `message`, as "$<N>" or "<N> dollar(s)".
 *
 * Deliberately excludes any mention carrying a fractional part other than
 * an exact ".00" ("$12.50" is not evidence for either "12" or "50" — the
 * two halves of that string are not independently meaningful dollar
 * figures, and treating them as such would manufacture false evidence
 * from a genuinely fractional price the operator spoke correctly).
 *
 * Returns whole DOLLAR amounts (not cents) — pair with
 * `correctDollarScaleIfSpoken`, which does the actual x100 conversion
 * only when a line's raw price exactly equals one of these.
 */
const SPOKEN_AMOUNT_RE = /\$(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*dollars?\b/gi;

export function extractSpokenWholeDollarAmounts(message: string | undefined): Set<number> {
  const amounts = new Set<number>();
  if (!message) return amounts;
  SPOKEN_AMOUNT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPOKEN_AMOUNT_RE.exec(message)) !== null) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    if (raw.includes('.') && !raw.endsWith('.00')) continue;
    const dollars = Math.trunc(Number(raw));
    if (Number.isSafeInteger(dollars) && dollars > 0) amounts.add(dollars);
  }
  return amounts;
}

/**
 * Corrects a single line item's raw price to cents when — and only when —
 * it exactly matches a whole-dollar amount the operator spoke. Negative
 * values (credits) and non-integers are returned unchanged: the live bug
 * shape is a positive whole-dollar figure landing straight in a cents
 * field, never a credit line, and neither of the observed CORRECT
 * conversions in the wild (7500, -5000) needs or should get touched by
 * this at all.
 */
export function correctDollarScaleIfSpoken(
  rawCents: number,
  spokenDollarAmounts: ReadonlySet<number>,
): number {
  if (!Number.isInteger(rawCents) || rawCents <= 0) return rawCents;
  return spokenDollarAmounts.has(rawCents) ? rawCents * 100 : rawCents;
}
