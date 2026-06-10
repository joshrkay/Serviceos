import { z } from 'zod';

/**
 * Money wire formats. All amounts are integer cents. Quantities are integer
 * hundredths (150 = 1.5 units). Tax rates are basis points (875 = 8.75%).
 * The calculation logic lives in the API billing engine; these schemas are
 * the single wire-format source of truth for both client and server.
 */

export const centsSchema = z.number().int().min(0).max(1_000_000_000);
export const taxRateBpsSchema = z.number().int().min(0).max(10_000);
export const quantityHundredthsSchema = z.number().int().min(1).max(1_000_000);

export const lineItemInputSchema = z.object({
  description: z.string().min(1).max(500),
  quantityHundredths: quantityHundredthsSchema,
  unitPriceCents: centsSchema,
});
export type LineItemInput = z.infer<typeof lineItemInputSchema>;

export const lineItemSchema = lineItemInputSchema.extend({
  id: z.string().uuid(),
  amountCents: centsSchema,
  position: z.number().int().min(0),
});
export type LineItem = z.infer<typeof lineItemSchema>;

export const documentTotalsSchema = z.object({
  subtotalCents: centsSchema,
  taxCents: centsSchema,
  totalCents: centsSchema,
  taxRateBps: taxRateBpsSchema,
});
export type DocumentTotals = z.infer<typeof documentTotalsSchema>;
