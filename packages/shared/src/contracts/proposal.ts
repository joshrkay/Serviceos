import { z } from 'zod';
import { ProposalType } from '../enums.js';
import { proposalStatusSchema } from './status.js';

/**
 * P0-033 (F-1) — API-shaped proposal payload for web inbox/list UIs.
 * Subset of full server `Proposal`; extend additively only (Tier 2).
 */
export const proposalResponseSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  // Typed to the canonical ProposalType enum, kept in exact lockstep with the
  // API's VALID_PROPOSAL_TYPES union via proposal-type.test.ts.
  proposalType: z.nativeEnum(ProposalType),
  status: proposalStatusSchema,
  summary: z.string(),
  explanation: z.string().optional(),
  confidenceScore: z.number().optional(),
  confidenceFactors: z.array(z.string()).optional(),
  payload: z.record(z.unknown()),
  sourceContext: z.record(z.unknown()).optional(),
  targetEntityType: z.string().optional(),
  targetEntityId: z.string().optional(),
  resultEntityId: z.string().optional(),
  // Finding 2 — undo-window honesty. `approvedAt` is the server-stamped
  // approval instant; `undoExpiresAt` = approvedAt + UNDO_WINDOW_MS. Both are
  // ISO strings, both optional (present only on the approve response / an
  // approved proposal), so this stays backward compatible with every existing
  // inbox/list consumer that never reads them.
  approvedAt: z.string().optional(),
  undoExpiresAt: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProposalResponse = z.infer<typeof proposalResponseSchema>;

/**
 * Human labels for the FLAT payload keys that money/reference-path task
 * handlers gate on via `sourceContext.missingFields`.
 *
 * Shared because more than one surface renders the same list and they were
 * drifting: the assistant route had this map (routes/assistant.ts) while the
 * web INBOX — the primary surface a voice-drafted proposal lands on —
 * rendered the raw key, or nothing at all (review J8/K4). One definition, so
 * a newly-gated field is labelled everywhere or nowhere.
 *
 * Entries are flat keys only. Path-shaped entries (`lineItems[0].…`) belong
 * to the candidate picker, not to a text-input form, and are filtered by
 * `isFlatMissingField` below exactly as `clearSatisfiedMissingFields`
 * (api proposals/missing-fields.ts) filters them.
 */
export const MISSING_FIELD_LABELS: Record<string, string> = {
  invoiceId: 'Invoice # or ID',
  estimateId: 'Estimate # or ID',
  jobId: 'Job # or ID',
  customerId: 'Customer name or ID',
  appointmentId: 'Appointment # or ID',
  leadId: 'Lead name or ID',
  // Not an id — the money gate on `update_catalog_item`, whose whole subject
  // is a price. Showing the raw key here is the defect that prompted the
  // shared map.
  proposedUnitPriceCents: 'Unit price ($)',
};

/** A `missingFields` entry an operator can fill with one flat-key edit. */
export function isFlatMissingField(key: string): boolean {
  return !key.includes('.') && !key.includes('[');
}

/** Label for a `missingFields` entry, falling back to the raw key. */
export function labelForMissingField(key: string): string {
  return MISSING_FIELD_LABELS[key] ?? key;
}
