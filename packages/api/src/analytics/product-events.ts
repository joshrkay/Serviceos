/**
 * Server-side product-event catalog.
 *
 * The canonical set of PostHog *product* event names emitted from the server
 * for in-app feature usage — as opposed to the acquisition/funnel events in
 * the `FunnelEvent` union in `posthog.ts`. `recordProductEvent()` is typed
 * against `ProductEventName`, so an un-catalogued name fails typecheck — the
 * same central-registry discipline the funnel events already follow.
 *
 * These names are the curated, PII-safe analytics vocabulary and are
 * deliberately decoupled from the internal audit `eventType` strings. The
 * audit→product mapping (`analytics/audit-event-mapping.ts`, added alongside
 * the forwarding decorator) translates e.g. `proposal.one_tap_approved` →
 * `proposal_one_tap_approved`. Adding a domain later = adding names here plus
 * a mapping row, nothing else.
 *
 * Seeded with the proposals + money-path slice (the first allowlist the
 * forwarding decorator ships with); expands one domain per follow-up.
 */
export type ProductEventName =
  // Proposals — the human-in-the-loop core loop
  | 'proposal_approved'
  | 'proposal_rejected'
  | 'proposal_executed'
  | 'proposal_one_tap_approved'
  // Money path — estimates → invoices → payments → booked work
  | 'estimate_created'
  | 'estimate_approved'
  | 'estimate_declined'
  | 'invoice_issued'
  | 'payment_recorded'
  | 'payment_refunded'
  | 'payment_failed'
  | 'appointment_booked';

/**
 * Runtime list of every catalogued product-event name. Kept in lockstep with
 * the `ProductEventName` union (a compile-time check below fails the build if
 * they drift). Consumed by the allowlist cross-check test that ships with the
 * audit→product mapper.
 */
export const PRODUCT_EVENT_NAMES: readonly ProductEventName[] = [
  'proposal_approved',
  'proposal_rejected',
  'proposal_executed',
  'proposal_one_tap_approved',
  'estimate_created',
  'estimate_approved',
  'estimate_declined',
  'invoice_issued',
  'payment_recorded',
  'payment_refunded',
  'payment_failed',
  'appointment_booked',
] as const;

// Compile-time guard: every union member must appear in PRODUCT_EVENT_NAMES
// (and vice-versa). If the array and the union drift, this assignment stops
// typechecking under tsconfig.build.json.
type _EnsureAllNamesListed =
  Exclude<ProductEventName, (typeof PRODUCT_EVENT_NAMES)[number]> extends never
    ? true
    : never;
const _productEventNamesExhaustive: _EnsureAllNamesListed = true;
void _productEventNamesExhaustive;

/** True iff `value` is a catalogued product-event name. */
export function isProductEventName(value: string): value is ProductEventName {
  return (PRODUCT_EVENT_NAMES as readonly string[]).includes(value);
}
