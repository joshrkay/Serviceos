import { z } from 'zod';
import { LineItemCategory } from '../enums.js';

/**
 * Canonical money primitives shared by estimates and invoices — reconciled to
 * the billing engine (`packages/api/src/shared/billing-engine.ts`). All amounts
 * are integer cents; tax is basis points. These are the single source of truth
 * for the LineItem / DocumentTotals shapes both documents serialize.
 */

export const lineItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  category: z.nativeEnum(LineItemCategory).optional(),
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
