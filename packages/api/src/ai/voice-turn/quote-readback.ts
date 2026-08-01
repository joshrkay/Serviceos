/**
 * WS5 — in-call grounded quote read-back.
 *
 * Pure, deterministic string builder for what the live voice agent SAYS
 * after a caller describes work and we draft an estimate. The rules exist
 * to protect money-correctness on the spoken channel:
 *
 *   - We NEVER speak an LLM-invented number. Prices only ever come from the
 *     tenant catalog (via `groundLineItemPricing`); a line that resolved to
 *     a catalog item carries `pricingSource: 'catalog'` and the catalog's
 *     integer-cents price.
 *   - We NEVER speak a number for uncatalogued OR ambiguous work — those
 *     get a no-number acknowledgment and defer to the operator's written
 *     quote. Same for "catalog unavailable" (a read timeout / unwired repo):
 *     absent grounding, we must not quote.
 *   - Prices are spoken ONLY for a FULLY-catalogued quote (every line a clean
 *     catalog match). A mixed quote (any uncatalogued / ambiguous line) keeps
 *     the all-or-nothing no-number rule — never a partial recital.
 *   - Within a fully-catalogued quote (WS17 I2): a single line speaks its
 *     price; 2..`PER_LINE_READBACK_MAX_LINES` lines speak each line's price
 *     followed by the total ("The water heater is $1,850, and the gasket is
 *     $9 — that's $1,859 all together. I'll send the full quote to
 *     confirm."); more lines than that speak the TOTAL only (a long per-line
 *     recital would overwhelm the caller). The total is always the last
 *     figure spoken, and every priced read-back ends with the written-quote
 *     confirmation suffix.
 *
 * No I/O, no LLM — trivially unit-testable, and the exact strings are pinned
 * by tests so a copy tweak can't silently change what a caller is told about
 * their money.
 */
import { formatCents } from '../skills/spoken-format';

/**
 * The pre-WS5 fixed confirmation line, kept verbatim so NON-estimate
 * proposals (and estimates with no line items) speak exactly what they did
 * before. Sourced from the `proposal_draft` transition.
 */
export const GENERIC_PROPOSAL_CONFIRMATION =
  "Great, I've got that taken care of. You'll receive a confirmation shortly. Is there anything else I can help you with?";

/**
 * No-number acknowledgment spoken whenever ANY line is uncatalogued /
 * ambiguous, or the catalog could not be consulted. Defers pricing to the
 * operator's written quote — deliberately carries no dollar figure.
 */
export const UNCATALOGUED_QUOTE_READBACK =
  "I've got the details — the owner will confirm pricing and you'll get the full quote by text.";

/** One grounded line item, as produced by `applyCatalogPricing`. */
export interface QuoteReadbackLine {
  /** 'catalog' | 'ambiguous' | 'uncatalogued' | 'manual' | undefined. */
  pricingSource?: string;
  /** Integer cents — the estimate contract's price field. */
  unitPrice?: number;
  quantity?: number;
  description?: string;
}

export interface QuoteReadbackInput {
  /** Grounded line items (post `groundLineItemPricing`). */
  lineItems: QuoteReadbackLine[];
  /**
   * False when the tenant catalog could not be loaded in time (preload
   * timeout, read error, or no repo wired). Forces the no-number read-back
   * regardless of line contents — we never quote without a grounding source.
   */
  catalogAvailable: boolean;
}

/**
 * WS17 (I2) — upper bound on how many all-catalogued lines get a per-line
 * price recital before we fall back to a total-only read-back. At or below
 * this many lines the caller hears each line plus the total; above it, only
 * the total (a long spoken list would overwhelm rather than reassure).
 */
export const PER_LINE_READBACK_MAX_LINES = 3;

/** Integer-cents line total (unit price × quantity, quantity defaulting to 1). */
function lineTotalCents(li: QuoteReadbackLine): number {
  const qty = typeof li.quantity === 'number' && li.quantity > 0 ? li.quantity : 1;
  return (li.unitPrice ?? 0) * qty;
}

/** Effective quantity for a line (≥ 1). */
function lineQuantity(li: QuoteReadbackLine): number {
  return typeof li.quantity === 'number' && li.quantity > 0 ? li.quantity : 1;
}

/**
 * Spoken pluralisation for a qty>1 line, using the standard small English
 * rules: already ends in s → unchanged ("Gaskets"); ends in s/x/z/ch/sh →
 * +es ("Box" → "Boxes", "Brush" → "Brushes"); consonant+y → ies
 * ("Assembly" → "Assemblies"); default +s ("Gasket" → "Gaskets"). No
 * irregular table — anything beyond these rules keeps +s. This feeds TTS
 * the owner's customers hear, so "Boxs" is not acceptable output.
 */
function pluralizeDescription(desc: string): string {
  if (/s$/i.test(desc)) return desc;
  if (/(?:x|z|ch|sh)$/i.test(desc)) return `${desc}es`;
  if (/[^aeiou\s]y$/i.test(desc)) return `${desc.slice(0, -1)}ies`;
  return `${desc}s`;
}

/**
 * One line's spoken clause. qty 1 → "the water heater is $1,850"; qty>1 →
 * "3 smoke detectors are $267" (the price is the LINE total, unit×qty).
 */
function linePhrase(li: QuoteReadbackLine): string {
  const price = formatCents(lineTotalCents(li));
  const desc = li.description ?? 'item';
  const qty = lineQuantity(li);
  return qty > 1
    ? `${qty} ${pluralizeDescription(desc)} are ${price}`
    : `the ${desc} is ${price}`;
}

/** Join clauses with an Oxford-style "and" ("a, b, and c"; "a, and b"). */
function joinPhrases(phrases: string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  if (phrases.length === 2) return `${phrases[0]}, and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`;
}

function capitalizeFirst(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Build the spoken read-back for a drafted estimate/invoice. See module header
 * for the safety rules. Returns exactly one of:
 *   - the generic confirmation (no line items),
 *   - the no-number acknowledgment (catalog unavailable, or ANY line not
 *     cleanly catalog-priced — the all-or-nothing mixed-quote rule),
 *   - a single grounded price (one catalogued line),
 *   - a per-line recital + grounded TOTAL (2..N all-catalogued lines),
 *   - a grounded TOTAL only (more than N all-catalogued lines).
 */
export function buildQuoteReadback(input: QuoteReadbackInput): string {
  const lines = input.lineItems ?? [];
  if (lines.length === 0) return GENERIC_PROPOSAL_CONFIRMATION;
  if (!input.catalogAvailable) return UNCATALOGUED_QUOTE_READBACK;

  // Every line must be a clean catalog match with a numeric price. Any
  // uncatalogued / ambiguous / price-less line → no numbers at all.
  const allCatalogued = lines.every(
    (li) => li.pricingSource === 'catalog' && typeof li.unitPrice === 'number',
  );
  if (!allCatalogued) return UNCATALOGUED_QUOTE_READBACK;

  if (lines.length === 1) {
    const li = lines[0]!;
    return `For the ${li.description}, that's typically ${formatCents(lineTotalCents(li))}. I'll send the full quote to confirm.`;
  }

  const total = lines.reduce((sum, li) => sum + lineTotalCents(li), 0);

  // 2..N all-catalogued lines: recite each line, then the total last. The
  // confirmation suffix stays — it sets the expectation that a formal written
  // quote follows the spoken number (trust + the close-the-sale flow).
  if (lines.length <= PER_LINE_READBACK_MAX_LINES) {
    const sentence = capitalizeFirst(joinPhrases(lines.map(linePhrase)));
    return `${sentence} — that's ${formatCents(total)} all together. I'll send the full quote to confirm.`;
  }

  // More than N lines: a per-line recital would overwhelm — total only.
  return `That usually comes to about ${formatCents(total)} all together. I'll send the full quote to confirm.`;
}
