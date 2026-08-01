/**
 * Zod-pinned public estimate view fixture for hermetic `/e/:id` e2e.
 *
 * There is no shared `PublicEstimateView` Zod schema yet (the type lives
 * as a TS interface on the API + web). This local schema mirrors the
 * fields `EstimateApprovalPage` reads so fixture drift fails at build
 * time instead of silently painting wrong money/customer chrome.
 */
import { z } from 'zod';

const publicEstimateLineItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  quantity: z.number().finite(),
  unitPriceCents: z.number().int(),
  totalCents: z.number().int(),
  taxable: z.boolean().optional(),
  groupKey: z.string().optional(),
  groupLabel: z.string().optional(),
  isOptional: z.boolean().optional(),
  isDefaultSelected: z.boolean().optional(),
});

export const publicEstimateViewSchema = z.object({
  id: z.string().min(1),
  estimateNumber: z.string().min(1),
  status: z.string().min(1),
  customerName: z.string().min(1),
  customerAddress: z.string().optional(),
  businessName: z.string().min(1),
  businessPhone: z.string().optional(),
  businessEmail: z.string().optional(),
  estimateLabel: z.string().optional(),
  lineItems: z.array(publicEstimateLineItemSchema).min(1),
  hasSelectableItems: z.boolean().optional(),
  taxRateBps: z.number().int().optional(),
  totalCents: z.number().int(),
  subtotalCents: z.number().int(),
  taxCents: z.number().int(),
  discountCents: z.number().int(),
  validUntil: z.string().optional(),
  customerMessage: z.string().optional(),
  isActionable: z.boolean(),
  acceptedAt: z.string().optional(),
  acceptedByName: z.string().optional(),
  rejectedAt: z.string().optional(),
  rejectedReason: z.string().optional(),
  isExpired: z.boolean(),
  version: z.number().int(),
  lastRevisedAt: z.string().optional(),
  depositRequiredCents: z.number().int().optional(),
  depositPaidCents: z.number().int().optional(),
  depositStatus: z.enum(['not_required', 'pending', 'paid']).optional(),
  depositPayable: z.boolean().optional(),
  depositTimingPolicy: z.enum(['before_approval', 'after_approval']).optional(),
  depositCheckoutUrl: z.string().optional(),
  depositCheckoutExpiresAt: z.string().optional(),
});

export type PublicEstimateViewFixture = z.infer<typeof publicEstimateViewSchema>;

/** Distinct from the mobile-layout fixture customer (Sarah Johnson). */
export const VIEW_TOKEN = 'e2e_w1_3_estimate_token_abcdefgh';

export const sentEstimateView: PublicEstimateViewFixture = publicEstimateViewSchema.parse({
  id: 'est_e2e_w1_3',
  estimateNumber: 'EST-W1-3001',
  status: 'sent',
  customerName: 'Morgan Rivera',
  customerAddress: '88 Hermetic Ave, Austin, TX',
  businessName: 'River Bend HVAC',
  businessPhone: '+15555550123',
  estimateLabel: 'Estimate',
  lineItems: [
    {
      id: 'li_e2e_1',
      description: 'Condenser fan motor',
      quantity: 1,
      unitPriceCents: 18_500,
      totalCents: 18_500,
      taxable: true,
    },
    {
      id: 'li_e2e_2',
      description: 'Diagnostic labor',
      quantity: 1,
      unitPriceCents: 12_500,
      totalCents: 12_500,
      taxable: false,
    },
  ],
  hasSelectableItems: false,
  taxRateBps: 0,
  totalCents: 31_000,
  subtotalCents: 31_000,
  taxCents: 0,
  discountCents: 0,
  customerMessage: 'Service call — outdoor unit not spinning',
  isActionable: true,
  isExpired: false,
  version: 1,
  depositRequiredCents: 0,
  depositPaidCents: 0,
  depositStatus: 'not_required',
  depositPayable: false,
  depositTimingPolicy: 'after_approval',
});

export function acceptedEstimateView(
  acceptedByName: string,
): PublicEstimateViewFixture {
  return publicEstimateViewSchema.parse({
    ...sentEstimateView,
    status: 'accepted',
    isActionable: false,
    acceptedAt: '2026-07-10T12:00:00.000Z',
    acceptedByName,
  });
}
