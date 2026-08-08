import { z } from 'zod';
import { catalogUnitSchema } from '@ai-service-os/shared';

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
 * (description / quantity / unitPriceCents), PLUS the same catalog-
 * grounding passthrough fields `contracts.ts`'s shared `lineItemSchema`
 * declares (unit / category / catalogItemId / pricingSource / needsPricing
 * / totalCents / imageFileId / id). This is NOT decorative: Zod strips any
 * key not declared on an object schema, and
 * `CreateChangeOrderExecutionHandler` runs `createChangeOrderPayloadSchema
 * .safeParse()` BEFORE handing the line items to `normalizeDraftLineItems`
 * (execution/handlers.ts). Two of these fields ARE forwarded onto the
 * persisted `estimate_line_items` row by that function — `pricingSource`
 * (the durable catalog-grounded-vs-AI-invented signal) and `unit`/
 * `category`/`totalCents`/`imageFileId`/`id` — so omitting them from this
 * schema silently destroyed that signal between the approved payload and
 * the DB row (the same parity bug B7.5 — see the `unit` comment on
 * `contracts.ts`'s `lineItemSchema` — and EE-4 — see `imageFileId` there
 * and the "parity bug this unit exists to prevent" comment on
 * `normalizeDraftLineItems`, execution/handlers.ts — were fixed for the
 * shared estimate/invoice path). `catalogItemId`/`needsPricing` are NOT
 * persisted `LineItem` fields at all (no such column exists on
 * `estimate_line_items`) — they are declared here purely so they survive
 * on the PAYLOAD for the review UI's one-tap ambiguity resolution, the
 * same reason `contracts.ts`'s shared schema declares them.
 * `unitPriceCents` is optional pre-grounding (the drafting task may hand
 * off to catalog resolution with only a description); the execution
 * handler's line-item normalization refuses to persist a line with no
 * resolvable price. Deliberately excludes the good-better-best tier
 * fields (groupKey/groupLabel/isOptional/isDefaultSelected) — a change
 * order is a single scoped addition, never a tiered quote.
 */
const changeOrderLineItemSchema = z.object({
  id: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPriceCents: z.number().int().min(0).optional(),
  totalCents: z.number().optional(),
  // B7.5 — descriptive unit of measure; never used in money math (price
  // stays in unitPriceCents). See the module doc comment above.
  unit: catalogUnitSchema.optional(),
  category: z.string().optional(),
  catalogItemId: z.string().uuid().optional(),
  pricingSource: z.enum(['catalog', 'ambiguous', 'uncatalogued', 'manual']).optional(),
  needsPricing: z.boolean().optional(),
  // EE-4 — catalog image snapshot stamped by the catalog resolver. See the
  // module doc comment above.
  imageFileId: z.string().optional(),
});

export const createChangeOrderPayloadSchema = z.object({
  jobId: z.string().uuid(),
  title: z.string().min(1),
  lineItems: z.array(changeOrderLineItemSchema).min(1),
  customerMessage: z.string().optional(),
});

export type CreateChangeOrderPayload = z.infer<typeof createChangeOrderPayloadSchema>;

/**
 * Single source of truth for the change-order title shape, imported by
 * BOTH `CreateChangeOrderTaskHandler` (drafting) and
 * `CreateChangeOrderExecutionHandler` (execution) — quality-review fix for
 * a double-prefix bug the duplicated em-dash literal caused: the task
 * emitted the bare fallback `'Change order'` (no description spoken), and
 * the handler's `startsWith('Change order — ')` defensive check was FALSE
 * for that bare string, so it re-prefixed into
 * `"Change order — Change order — created from voice change-order
 * proposal <id>"`.
 */
export const CHANGE_ORDER_PREFIX = 'Change order — ';
const BARE_CHANGE_ORDER_TITLE = 'Change order';

/** Build the change order's title from the spoken work description (drafting leg). */
export function changeOrderTitle(description?: string): string {
  const trimmed = description?.trim();
  return trimmed ? `${CHANGE_ORDER_PREFIX}${trimmed}` : BARE_CHANGE_ORDER_TITLE;
}

/**
 * Defensive re-prefix for a hand-edited or re-drafted proposal payload
 * whose title wasn't produced by `changeOrderTitle()` above (execution
 * leg). Idempotent against BOTH shapes `changeOrderTitle()` can produce —
 * the prefixed form and the bare fallback — so it never double-prefixes.
 */
export function ensureChangeOrderTitle(title: string): string {
  if (title === BARE_CHANGE_ORDER_TITLE || title.startsWith(CHANGE_ORDER_PREFIX)) {
    return title;
  }
  return `${CHANGE_ORDER_PREFIX}${title}`;
}
