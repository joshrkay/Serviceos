import { z } from 'zod';
import { recurrenceRuleSchema, priceCentsSchema } from '../../agreements/enums';

/**
 * create_service_agreement proposal payload (Task 7, 2026-08-07
 * tradesperson plan).
 *
 * Signs a customer up for a recurring maintenance plan/membership — writes
 * a `service_agreements` row (migration 056, already live). No money moves
 * at creation: the agreement's OWN recurring sweep
 * (`agreements/agreement-service.ts runDueAgreements`, driven by
 * `workers/recurring-agreements-worker.ts`) generates the job/invoice
 * later, and those invoices ride the normal review path — so this is
 * capture-class (`proposals/proposal.ts actionClassForProposalType`), same
 * posture as `draft_estimate` / `create_change_order`.
 *
 * `recurrenceRule` and `priceCents` reuse the EXACT schemas
 * (`agreements/enums.ts`) the authenticated `POST /api/agreements` route
 * validates against, so a voice-drafted agreement can never accept an
 * RRULE shape or price the recurrence engine
 * (`agreements/recurrence.ts parseRule`) or the route would reject.
 *
 * `startsOn` requires a REAL calendar date, not just `YYYY-MM-DD` shape:
 * `computeFirstRun` (agreements/agreement-service.ts, also used by this
 * type's execution handler) feeds the string straight into `Date.UTC` with
 * no further validation, so an out-of-range day (e.g. "2026-02-30") would
 * silently roll over to a WRONG date (March 2) rather than fail loudly —
 * refined here so the contract catches it before it ever reaches that
 * computation.
 *
 * `locationId`/`description` are declared (mirroring the authenticated
 * route's own optional fields) but are not populated by the voice drafting
 * task in v1 — no location-reference extraction seam exists for this
 * intent yet.
 */
const startsOnSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'startsOn must look like YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'startsOn must be a real calendar date');

export const createServiceAgreementPayloadSchema = z.object({
  customerId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  recurrenceRule: recurrenceRuleSchema,
  priceCents: priceCentsSchema,
  startsOn: startsOnSchema,
});

export type CreateServiceAgreementPayload = z.infer<typeof createServiceAgreementPayloadSchema>;
