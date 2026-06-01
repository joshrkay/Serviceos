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

export const lineItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  category: lineItemCategorySchema.optional(),
  // quantity is NUMERIC server-side and may be fractional (e.g. 1.5 hrs).
  quantity: z.number(),
  unitPriceCents: z.number().int(),
  totalCents: z.number().int(),
  sortOrder: z.number().int(),
  taxable: z.boolean(),
  // Good-better-best: items sharing a non-null groupKey are mutually exclusive tiers.
  groupKey: z.string().optional(),
  groupLabel: z.string().optional(),
  isOptional: z.boolean().optional(),
  isDefaultSelected: z.boolean().optional(),
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
