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
 * `recurrenceRule` reuses the EXACT schema (`agreements/enums.ts`) the
 * authenticated `POST /api/agreements` route validates against, so a
 * voice-drafted agreement can never accept an RRULE shape the recurrence
 * engine (`agreements/recurrence.ts parseRule`) or the route would reject.
 *
 * `priceCents` is `priceCentsSchema` PLUS a sanity ceiling (quality-review
 * I-minor): `priceCentsSchema` alone allows up to `Number.MAX_SAFE_INTEGER`,
 * which would happily persist a misheard "290 thousand a year" as a
 * $2.9M/period plan. `PRICE_CENTS_SANITY_CEILING` ($100,000/period) is a
 * backstop against exactly that class of voice mis-parse, not a real
 * product limit — a legitimate commercial contract above this ceiling
 * still goes through the authenticated route/UI, which does not import
 * this ceiling.
 *
 * `priceCentsSchema` itself is `nonnegative()` — a $0/comp plan is
 * STRUCTURALLY legal for this proposal type (the authenticated route
 * accepts one). `CreateServiceAgreementTaskHandler` (the only voice
 * producer of this payload today) is stricter than the contract on
 * purpose: it gates on a POSITIVE spoken amount (`ee.amount > 0`) because
 * voice has no way to distinguish "the caller said zero dollars" from
 * "the caller didn't state a price" — so the voice path can never
 * currently produce `priceCents: 0`. That is an intentional drafting-task
 * decision, not a contract bug; the contract stays permissive for other,
 * non-voice callers (a hand-edited proposal, or a future comp-plan UI
 * path) that CAN honestly assert a $0 price.
 *
 * `startsOn` requires a REAL calendar date, not just `YYYY-MM-DD` shape:
 * `computeFirstRun` (agreements/agreement-service.ts, called via
 * `createAgreement` by this type's execution handler) feeds the string
 * straight into `Date.UTC` with no further validation, so an out-of-range
 * day (e.g. "2026-02-30") would silently roll over to a WRONG date (March
 * 2) rather than fail loudly — refined here so the contract catches it
 * before it ever reaches that computation.
 *
 * `startsOn` additionally rejects a date already in the past (quality-
 * review I2, defense in depth). The PRIMARY guard is in the drafting task
 * (`create-service-agreement-task.ts parseSpokenStartsOn`, tenant-timezone
 * aware); this is a backstop against a hand-crafted/malformed payload
 * bypassing that guard, using the server's wall-clock date (computed FRESH
 * on every validation call, not baked in at module load). Necessary
 * because a back-dated `nextRunAt` is not just wrong-looking on a review
 * card: `runDueAgreements` (the recurring sweep, which runs every 60
 * seconds — app.ts) would pick it up on its very next tick and advance
 * ONE interval per pass, so a back-dated MONTHLY plan drips a job+invoice
 * pair roughly once a MINUTE until it catches up to today.
 *
 * Quality-review N3 — the past-date backstop compares against server UTC
 * (`new Date().toISOString().slice(0, 10)`), NOT the tenant's local date.
 * This is DELIBERATE: the contract has no tenant-timezone context to
 * compare against (that context lives on `TaskContext`, several layers
 * up, and never reaches Zod validation). The PRIMARY guard (the drafting
 * task's `parseSpokenStartsOn`/tenant-local default) is already correctly
 * tenant-aware; this backstop only ever fires for a hand-crafted payload
 * that bypassed it. Comparing in UTC errs in the SAFE direction — for a
 * tenant west of UTC, a legitimately-today local date can read as
 * "yesterday" in UTC after local 5pm-ish and get rejected — a false
 * positive that sends the operator to redraft, never a false negative
 * that lets a stale date slip through.
 *
 * Quality-review N1 — `createServiceAgreementShapeSchema` (below,
 * exported) is the SAME object shape MINUS the past-date check, so the
 * execution handler can distinguish "this payload is genuinely malformed"
 * from "every field is fine, but the plan's startsOn LAPSED between
 * drafting and approval" and give the operator an actionable message
 * instead of a generic one that sends them hunting for the wrong field.
 * A proposal drafted with "starting September 1" and approved on
 * September 2 hits exactly this case — the default first-of-next-month
 * gives ~30 days of slack, so it is rare, but a spoken explicit date
 * makes it real.
 *
 * `locationId`/`description` are declared (mirroring the authenticated
 * route's own optional fields). `locationId` is not populated by the
 * voice drafting task (no location-reference extraction seam for this
 * intent) — the execution handler resolves the customer's primary/
 * fallback service location itself when the payload omits it (see
 * `create-service-agreement-handler.ts`'s class doc comment, C1).
 */
const PRICE_CENTS_SANITY_CEILING = 100_000_00; // $100,000 per period

const priceCentsWithSanityCeilingSchema = priceCentsSchema.max(
  PRICE_CENTS_SANITY_CEILING,
  `priceCents exceeds the sanity ceiling for a recurring plan (max $${(PRICE_CENTS_SANITY_CEILING / 100).toLocaleString('en-US')}/period) — check for a dollars/thousands mix-up`,
);

/** Shape + real-calendar-date validity ONLY — no past-date check. See `createServiceAgreementShapeSchema` doc comment (N1). */
const startsOnShapeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'startsOn must look like YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'startsOn must be a real calendar date');

/**
 * Every field EXCEPT the past-date check on `startsOn` (quality-review
 * N1). Exported so `CreateServiceAgreementExecutionHandler` can tell "the
 * ONLY problem is a lapsed start date" apart from "this payload is
 * missing/malformed fields": parse against this schema first — a success
 * here plus a failure against the full schema below means startsOn is the
 * sole offender, and specifically because it has lapsed (every other
 * shape check, including calendar-date validity, already passed).
 */
export const createServiceAgreementShapeSchema = z.object({
  customerId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  recurrenceRule: recurrenceRuleSchema,
  priceCents: priceCentsWithSanityCeilingSchema,
  startsOn: startsOnShapeSchema,
});

export const createServiceAgreementPayloadSchema = createServiceAgreementShapeSchema.refine(
  // Computed fresh per call — never hoist "today" to module-load time.
  // See the module doc comment (N3) for why this compares in UTC.
  (data) => data.startsOn >= new Date().toISOString().slice(0, 10),
  { message: 'startsOn must not be in the past', path: ['startsOn'] },
);

export type CreateServiceAgreementPayload = z.infer<typeof createServiceAgreementPayloadSchema>;
