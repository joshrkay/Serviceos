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
 *   - At most ONE spoken price per turn (single line → that line's price;
 *     multiple all-catalogued lines → the TOTAL only, never a per-line
 *     recital that would speak several numbers).
 *
 * No I/O, no LLM — trivially unit-testable, and the exact strings are pinned
 * by tests so a copy tweak can't silently change what a caller is told about
 * their money.
 */
import { formatCents } from '../skills/spoken-format';
import { t, type Language } from '../i18n/i18n';

/**
 * The pre-WS5 fixed confirmation line, kept verbatim so NON-estimate
 * proposals (and estimates with no line items) speak exactly what they did
 * before. Sourced from the `proposal_draft` transition and now backed by
 * the voice i18n catalog so a Spanish call hears the Spanish line. The
 * exported English constant is the catalog's English value verbatim — it
 * remains the exact-match key `SENTENCE_CATALOG_ES` uses.
 */
export const GENERIC_PROPOSAL_CONFIRMATION = t('quote.confirmation_generic', 'en');

/**
 * No-number acknowledgment spoken whenever ANY line is uncatalogued /
 * ambiguous, or the catalog could not be consulted. Defers pricing to the
 * operator's written quote — deliberately carries no dollar figure.
 */
export const UNCATALOGUED_QUOTE_READBACK = t('quote.uncatalogued', 'en');

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

/** Integer-cents line total (unit price × quantity, quantity defaulting to 1). */
function lineTotalCents(li: QuoteReadbackLine): number {
  const qty = typeof li.quantity === 'number' && li.quantity > 0 ? li.quantity : 1;
  return (li.unitPrice ?? 0) * qty;
}

/**
 * Build the spoken read-back for a drafted estimate. See module header for
 * the safety rules. Returns exactly one of:
 *   - the generic confirmation (no line items),
 *   - the no-number acknowledgment (catalog unavailable, or any line not
 *     cleanly catalog-priced),
 *   - a single grounded price (one catalogued line),
 *   - a single grounded TOTAL (multiple all-catalogued lines).
 *
 * `language` picks the spoken language ('en' | 'es'), defaulting to English.
 * The strings come from the voice i18n catalog so the caller hears their own
 * language — this is the localization seam the pre-WS5 fixed line used. The
 * function stays PURE: the caller (the voice-turn processor) passes the
 * resolved session language in; no I/O, no session lookup here. Money is
 * still formatted with `formatCents` (bare `$N.NN`) — the US-only spoken
 * money contract that both TTS engines read correctly.
 */
export function buildQuoteReadback(
  input: QuoteReadbackInput,
  language: Language = 'en',
): string {
  const lines = input.lineItems ?? [];
  if (lines.length === 0) return t('quote.confirmation_generic', language);
  if (!input.catalogAvailable) return t('quote.uncatalogued', language);

  // Every line must be a clean catalog match with a numeric price. Any
  // uncatalogued / ambiguous / price-less line → no numbers at all.
  const allCatalogued = lines.every(
    (li) => li.pricingSource === 'catalog' && typeof li.unitPrice === 'number',
  );
  if (!allCatalogued) return t('quote.uncatalogued', language);

  if (lines.length === 1) {
    const li = lines[0]!;
    return t('quote.single_line', language, {
      description: li.description ?? '',
      amount: formatCents(lineTotalCents(li)),
    });
  }

  const total = lines.reduce((sum, li) => sum + lineTotalCents(li), 0);
  return t('quote.total', language, { amount: formatCents(total) });
}
