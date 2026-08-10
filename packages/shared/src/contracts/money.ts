import { z } from 'zod';

/**
 * Canonical money primitives shared by estimates and invoices — reconciled to
 * the billing engine (`packages/api/src/shared/billing-engine.ts`). All amounts
 * are integer cents; tax is basis points. These are the single source of truth
 * for the LineItem / DocumentTotals shapes both documents serialize.
 */

/**
 * Line-item category — string-literal union from the DB-true values
 * (estimate_line_items / invoice_line_items `category` CHECK and the billing
 * engine's LineItemCategory), kept in lockstep with both by money.test.ts.
 * Defined here rather than via z.nativeEnum(LineItemCategory) so it tracks the
 * persisted/billing-validated set, not the broader shared enum.
 */
export const lineItemCategorySchema = z.enum(['labor', 'material', 'equipment', 'other']);
export type LineItemCategoryValue = z.infer<typeof lineItemCategorySchema>;

/**
 * B7.5 — unit of measure for a spoken part ("three 45-microfarad capacitors",
 * "two hours of labor"). DESCRIPTIVE ONLY: price stays integer cents and
 * `quantity × unitPriceCents = totalCents` never consults this field, so no
 * billing arithmetic can be changed by it.
 *
 * Mirrors `CatalogUnit` (packages/api/src/catalog/catalog-item.ts) and is kept
 * in lockstep with it by money.test.ts, the same way the category enum is. The
 * DB column (migration 265) is a plain nullable TEXT with no CHECK: this enum
 * is the validation boundary, so adding a unit later stays a code change
 * rather than another migration.
 */
export const catalogUnitSchema = z.enum(['each', 'hour', 'sq ft', 'per lb', 'per gal']);
export type CatalogUnitValue = z.infer<typeof catalogUnitSchema>;

export const lineItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  // Nullish, not just optional: the DB columns (estimate_line_items /
  // invoice_line_items `category`) are nullable and document-row-mappers.ts
  // serializes `category: row.category` directly, so persisted rows arrive as
  // `category: null` (not an omitted field).
  category: lineItemCategorySchema.nullish(),
  // quantity is NUMERIC server-side and may be fractional (e.g. 1.5 hrs).
  quantity: z.number(),
  // B7.5 — descriptive unit of measure. Optional/nullish: every line written
  // before migration 265, and every path that doesn't state a unit, reads back
  // absent. Never participates in money math.
  unit: catalogUnitSchema.nullish(),
  unitPriceCents: z.number().int(),
  totalCents: z.number().int(),
  sortOrder: z.number().int(),
  taxable: z.boolean(),
  // Good-better-best: items sharing a non-null groupKey are mutually exclusive tiers.
  groupKey: z.string().optional(),
  groupLabel: z.string().optional(),
  isOptional: z.boolean().optional(),
  isDefaultSelected: z.boolean().optional(),
  // Catalog-grounding signal (estimates only). Carried from proposal
  // drafting (the catalog resolver stamps it) through to
  // estimate_line_items.pricing_source. Optional/nullish: invoice lines
  // and legacy estimate rows have no signal and serialize it as absent.
  pricingSource: z.enum(['catalog', 'ambiguous', 'uncatalogued', 'manual']).optional(),
  // EE-4 — frozen image snapshot (estimates only): the catalog item's file id
  // at draft/create time. Resolved to a signed URL only at the public edge.
  imageFileId: z.string().optional(),
});
export type LineItem = z.infer<typeof lineItemSchema>;

export const documentTotalsSchema = z.object({
  subtotalCents: z.number().int(),
  discountCents: z.number().int(),
  taxRateBps: z.number().int(),
  taxableSubtotalCents: z.number().int(),
  taxCents: z.number().int(),
  totalCents: z.number().int(),
});
export type DocumentTotals = z.infer<typeof documentTotalsSchema>;

/**
 * Format integer cents as a thousands-separated USD string for owner-facing
 * prose ("$1,250", "$1,250.50"). Integer math only — no float drift. Canonical
 * home for money display; prefer this over ad-hoc per-module formatters.
 */
export function formatUsdCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = abs % 100;
  return rem === 0 ? `${sign}$${dollars}` : `${sign}$${dollars}.${String(rem).padStart(2, '0')}`;
}

const USD_FIXED_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

const USD_WHOLE_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Format integer cents as a user-facing currency string that always keeps the
 * two-digit cents (`123450 → "$1,234.50"`, `5000 → "$50.00"`). Thousands
 * separators and correct negative placement (`-$5.00`, never `$-5.00`) come
 * from `Intl.NumberFormat`. Use this where trailing zero cents must show; use
 * `formatUsdCents` where whole dollars should drop the decimals.
 */
export function formatUsdCentsFixed(cents: number): string {
  return USD_FIXED_FORMATTER.format(cents / 100);
}

/**
 * Format integer cents as whole dollars, rounded, with thousands separators and
 * no cents (`125050 → "$1,251"`). For dashboard/summary tiles where cents are
 * noise. Rounds (not floors) to match the prior `maximumFractionDigits: 0`
 * call sites this replaces.
 */
export function formatUsdCentsWhole(cents: number): string {
  return USD_WHOLE_FORMATTER.format(cents / 100);
}

/**
 * Format integer cents as a bare `$N.NN` with two-digit cents and NO thousands
 * separators (`123450 → "$1234.50"`). For terse contexts — spoken prompts, SMS
 * bodies — where separators add noise. Prefer `formatUsdCentsFixed` for
 * on-screen display.
 */
export function formatUsdCentsPlain(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** True for integer-cents payload keys (`amountCents`, `unitPriceCents`, …). */
export function isCentsKey(key: string): boolean {
  return /cents$/i.test(key);
}

/**
 * Parse an operator's money INPUT (dollars) into integer cents, or null when
 * it isn't a money string. String math throughout — never
 * `Number(x) * 100`, which turns "0.29" into 28.999999999999996.
 *
 * Review J5 — lives here so the web chat card and the API's `editFields`
 * emitter agree on one parse. They previously had none at all: the card sent
 * the raw input STRING for a `z.number()` payload field and every money edit
 * 400'd with "Invalid payload after edit". Server-side coercion cannot
 * substitute for this — coercing "290000" would mean 290000 CENTS ($2,900),
 * wrong by 100x. `packages/mobile` carries local twins of these three
 * (proposals/proposalReview.ts, lib/format.ts) that predate this module and
 * behave identically; they should migrate here.
 */
export function parseMoneyToCents(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [dollars, frac = ''] = cleaned.split('.');
  return Number(dollars) * 100 + Number((frac + '00').slice(0, 2));
}

/**
 * Integer cents → the bare editable input text (`12345 → "123.45"`). The
 * inverse of {@link parseMoneyToCents}; no `$`/`,` so round-tripping an
 * untouched field never registers as an edit.
 */
export function centsToInputValue(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
