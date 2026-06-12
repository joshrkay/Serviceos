import { z } from 'zod';
import { estimateStatusSchema } from './status.js';
import { lineItemSchema, documentTotalsSchema } from './money.js';
import { customerSummarySchema } from './customer.js';

/**
 * Canonical Estimate entity contract — single source of truth for the estimate
 * shape the API serializes, reconciled to `packages/api/src/estimates/estimate.ts`
 * (`interface Estimate`). `status` reuses estimateStatusSchema (DB-parity guarded
 * by status.test.ts); lineItems/totals reuse the shared billing primitives in
 * ./money.ts. Over-the-wire dates are ISO strings.
 */
export const estimateSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  jobId: z.string().uuid(),
  estimateNumber: z.string(),
  status: estimateStatusSchema,
  lineItems: z.array(lineItemSchema),
  totals: documentTotalsSchema,
  validUntil: z.string().optional(),
  customerMessage: z.string().optional(),
  internalNotes: z.string().optional(),
  viewToken: z.string().optional(),
  viewTokenExpiresAt: z.string().optional(),
  sentAt: z.string().optional(),
  lastDispatchId: z.string().optional(),
  firstViewedAt: z.string().optional(),
  viewCount: z.number().int().optional(),
  acceptedAt: z.string().optional(),
  acceptedByName: z.string().optional(),
  acceptedByIp: z.string().optional(),
  acceptedUserAgent: z.string().optional(),
  acceptedSignatureData: z.string().optional(),
  rejectedAt: z.string().optional(),
  rejectedReason: z.string().optional(),
  // Optimistic-lock / customer re-sync counter; starts at 1, increments per persisted change.
  version: z.number().int(),
  lastRevisedAt: z.string().optional(),
  reminderCount: z.number().int().optional(),
  lastReminderAt: z.string().optional(),
  // estimate_line_item ids the customer chose at accept time (good-better-best).
  acceptedSelection: z.array(z.string()).optional(),
  deletedAt: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Estimate = z.infer<typeof estimateSchema>;

/**
 * Shape consumed by the estimates list/detail UI: the Estimate entity plus an
 * optional embedded `customer` summary a caller may join in. The bare
 * GET /api/estimates(/:id) returns unenriched Estimate entities, so `customer`
 * is optional and an unenriched response still validates.
 */
export const estimateResponseSchema = estimateSchema.extend({
  customer: customerSummarySchema.optional(),
});
export type EstimateResponse = z.infer<typeof estimateResponseSchema>;
