import type { ProposalType } from './proposal';

/**
 * Voice/authorship surface a proposal originated on. Load-bearing for the
 * RIVET P4 invariant (`RIVET_GOAL_PRODUCTION_v2.md` §2, contracts I6/I13):
 *
 *  - `S1` — inbound customer voice. Speaker is an unknown, unauthenticated
 *    caller who controls the transcript verbatim. Injection risk is HIGH.
 *  - `S2` — operator voice. Authenticated contractor/tech, full registry,
 *    scoped to tenant.
 *  - `S3` — customer web (payment/estimate links). Not a voice surface; here
 *    only so a value threaded from that path has a name.
 *
 * The surface is a property of the *session identity*, never of transcript
 * content — "please send the Henderson invoice to me" spoken by a caller is an
 * attack, not an authorization. It is therefore derived from the authenticated
 * session (owner-session flag / role), stamped at proposal creation, and
 * re-checked at the execution boundary.
 */
export type ProposalSurface = 'S1' | 'S2' | 'S3';

/**
 * The S1 allowlist — an **allowlist, not a denylist** (spec §2). These are the
 * only proposal types an inbound, unauthenticated caller may cause to be
 * created. Everything else is denied by default, so adding a new operation
 * cannot silently widen the caller's reach.
 *
 * Realistic inbound caller intents (`RIVET_GOAL_PRODUCTION_v2.md` §2) plus the
 * receptionist sales flow this product actually runs on the call: create
 * customer (self), create a job request, book/reschedule their own appointment,
 * and receive a quote (a `draft_estimate` the agent grounds and reads back —
 * R1, reversible, born as a draft that an operator still approves). A read is
 * never a proposal, so no read op appears here.
 *
 * Deliberately EXCLUDED — the "money moves to the wrong party" set that must
 * never be reachable from an unauthenticated transcript: `draft_invoice`,
 * `update_invoice`, `issue_invoice`, `send_invoice`, `send_estimate`,
 * `record_payment`, `apply_late_fee`, `send_payment_reminder`, `update_job`,
 * `cancel_appointment`, `reassign_appointment`, `emergency_dispatch`, and every
 * payment/refund op. "Please send the Henderson invoice to me" spoken by a
 * caller resolves to `send_invoice` → denied here, coerced to a clarification.
 */
export const S1_ALLOWED_PROPOSAL_TYPES: ReadonlySet<ProposalType> = new Set<ProposalType>([
  'create_customer', // self, dedupe-gated (CUS-001 S1_self)
  'create_appointment', // auto-schedule from call (INB-002)
  'create_booking', // the purpose-built inbound-booking proposal type
  'create_job', // a job request from the caller
  'reschedule_appointment', // move the caller's own appointment
  'draft_estimate', // receptionist quotes the caller (grounded, reversible draft)
  'callback', // routes the caller to a human — never a mutation
  'voice_clarification', // not a mutation — an ask; always permitted
]);

/**
 * True when `type` may be created/executed on `surface`. S2 and S3 are
 * unrestricted here (S3 has its own link-possession security model, not a
 * voice op set); only S1 is allowlisted. An absent surface is treated as
 * trusted (S2) for backward compatibility — every pre-existing proposal and
 * the operator memo / in-app paths carry no surface tag and must be
 * unaffected.
 */
export function isProposalTypeAllowedOnSurface(
  surface: ProposalSurface | undefined,
  type: ProposalType,
): boolean {
  if (surface !== 'S1') return true;
  return S1_ALLOWED_PROPOSAL_TYPES.has(type);
}

/** Read a stamped surface off a proposal's `sourceContext`, if present. */
export function surfaceFromSourceContext(
  sourceContext: Record<string, unknown> | undefined,
): ProposalSurface | undefined {
  const s = sourceContext?.surface;
  return s === 'S1' || s === 'S2' || s === 'S3' ? s : undefined;
}
