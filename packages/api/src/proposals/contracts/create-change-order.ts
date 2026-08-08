import { z } from 'zod';

/**
 * create_change_order proposal payload (Tradesperson wave 1, Task 6).
 *
 * A change order mints a NEW estimate pinned to an EXISTING job — mid-job
 * scope the customer asked for ("the Garcias want a second zone — change
 * order for 1800"), not a fresh bid. `jobId` is REQUIRED: that's what makes
 * this a change order rather than `draft_estimate` (whose jobId is
 * optional — see `DraftEstimateExecutionHandler`'s job auto-open fallback,
 * which deliberately has no analog here).
 *
 * Capture-class (proposals/proposal.ts actionClassForProposalType): no
 * money moves at creation, sending the resulting estimate to the customer
 * is a later, separate comms-class step (send_estimate) — same posture as
 * draft_estimate.
 *
 * `title` is a short, human-readable label for the change order (e.g.
 * "Change order — add second zone"), distinct from `customerMessage`
 * (optional customer-facing note carried onto the created estimate).
 * Estimates have no dedicated title column; `CreateChangeOrderExecutionHandler`
 * folds it into `internalNotes` alongside the proposal id for traceability.
 *
 * `lineItems` mirrors the shape `groundLineItemPricing` operates on
 * (description / quantity / unitPriceCents) — deliberately a narrower
 * contract than `draft_estimate`'s (no tiers/units/catalogItemId): a change
 * order is a single scoped addition, not a full quote rebuild.
 * `unitPriceCents` is optional pre-grounding (the drafting task may hand
 * off to catalog resolution with only a description); the execution
 * handler's line-item normalization refuses to persist a line with no
 * resolvable price.
 */
const changeOrderLineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPriceCents: z.number().int().min(0).optional(),
});

export const createChangeOrderPayloadSchema = z.object({
  jobId: z.string().uuid(),
  title: z.string().min(1),
  lineItems: z.array(changeOrderLineItemSchema).min(1),
  customerMessage: z.string().optional(),
});

export type CreateChangeOrderPayload = z.infer<typeof createChangeOrderPayloadSchema>;
