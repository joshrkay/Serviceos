/**
 * Voice-safety entity resolution for the calling agent.
 *
 * P0 invariant (CLAUDE.md): "All free-text entity references on voice paths
 * are resolved via the entity resolver; ambiguity becomes a one-tap
 * voice_clarification, never a silent guess."
 *
 * This module used to hand-roll customer/job/appointment lookups with
 * `display_name ILIKE '%name%' ORDER BY created_at DESC LIMIT 1` and recency
 * heuristics ("most recent active job", "next upcoming appointment"). Those
 * were SILENT GUESSES: two customers named "Bob Smith" → the newest was
 * picked and the caller/FSM/operator never saw an ambiguity signal. That
 * directly violated the invariant above.
 *
 * Now every free-text reference is resolved through the shared, tenant-scoped
 * `EntityResolver` (production: `PgEntityResolver`, pg_trgm similarity with
 * τ_ent=0.80). The resolver reports one of three outcomes per reference:
 *
 *   - resolved  → a single confident match; its id is threaded into refs.
 *   - ambiguous → 2+ matches above τ_ent; we surface the candidate list so
 *     the FSM can ask a one-tap disambiguation question (never a guess).
 *   - not_found → 0 matches; the FSM escalates to a human rather than
 *     inventing a target.
 *
 * The first reference that comes back ambiguous / not_found short-circuits
 * (one clarification/escalation at a time — the router pattern in
 * `workers/voice-action-router.ts`). Deterministic natural-language datetime
 * parsing stays inline: it is a PARSE, not an identity guess.
 *
 * When no resolver is configured (dev/no-DB), resolution is skipped
 * entirely — references pass through unresolved and the proposal surfaces
 * for operator review (HITL safety net). We never fabricate an id.
 */

import type {
  EntityResolver,
  EntityResolverResult,
  EntityCandidate,
  EntityKind,
} from '../../resolution/entity-resolver';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const GENERIC_CUSTOMER_REFS = new Set([
  'our customer', 'the customer', 'a customer', 'customer', 'them', 'that customer', 'this customer',
]);

export interface ParsedWindow {
  scheduledStart: string;
  scheduledEnd: string;
}

/**
 * Parse common dispatcher datetime phrasings relative to `now`:
 * "today/tomorrow/next tuesday/this friday/tuesday" + "at 2 PM" / "at 14:30".
 * Returns undefined when nothing parseable is found — never guesses.
 */
export function parseNaturalDatetime(desc: string, now: Date = new Date(), durationMinutes = 60): ParsedWindow | undefined {
  const text = desc.toLowerCase();

  let dayOffset: number | undefined;
  if (/\btoday\b/.test(text)) dayOffset = 0;
  else if (/\btomorrow\b/.test(text)) dayOffset = 1;
  else {
    const wd = Object.keys(WEEKDAYS).find((w) => text.includes(w));
    if (wd) {
      const target = WEEKDAYS[wd];
      const current = now.getUTCDay();
      let ahead = (target - current + 7) % 7;
      // Bare/this/next weekday: always the NEXT occurrence (never today —
      // a dispatcher saying "Tuesday" on a Tuesday means next week).
      if (ahead === 0) ahead = 7;
      dayOffset = ahead;
    }
  }

  const timeMatch = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (dayOffset === undefined && !timeMatch) return undefined;

  let hour = 9; // default morning slot when only a day was given
  let minute = 0;
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return undefined;
  }

  const start = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (dayOffset ?? 0),
    hour, minute, 0, 0,
  ));
  if (start.getTime() <= now.getTime()) start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
}

const SCHEDULING_CREATE_INTENTS = new Set(['create_appointment', 'create_booking']);
const APPOINTMENT_REF_INTENTS = new Set([
  'cancel_appointment', 'reschedule_appointment', 'confirm_appointment', 'reassign_appointment',
]);

/**
 * Outcome of resolving the scheduling references on one classified turn.
 *
 *  - `resolved`  → every reference that needed resolving was uniquely
 *    matched (or absent / skipped); `refs` carries the concrete
 *    ids/timestamps to thread into the proposal.
 *  - `ambiguous` → a reference matched 2+ candidates above τ_ent; `ambiguous`
 *    carries the candidate set so the FSM can ask ONE disambiguation
 *    question. No id is guessed.
 *  - `not_found` → a reference matched 0 candidates; the FSM escalates.
 */
export interface SchedulingEntityResolution {
  status: 'resolved' | 'ambiguous' | 'not_found';
  /** Concrete resolved refs (customerId/jobId/appointmentId/times/reason). */
  refs: Record<string, string>;
  /** Present only when status === 'ambiguous'. */
  ambiguous?: {
    entityKind: EntityKind;
    reference: string;
    candidates: EntityCandidate[];
  };
  /** Present only when status === 'not_found'. */
  notFound?: {
    entityKind: EntityKind;
    reference: string;
  };
}

/**
 * Fold a single resolver result into the running refs. Returns a terminal
 * SchedulingEntityResolution (ambiguous / not_found) when the reference could
 * not be uniquely resolved — the caller short-circuits on it so the FSM
 * surfaces exactly one clarification/escalation. Returns undefined when the
 * reference was uniquely resolved or skipped and processing should continue.
 */
function foldResolution(
  result: EntityResolverResult,
  entityKind: EntityKind,
  reference: string,
  refs: Record<string, string>,
  refKey: string,
): SchedulingEntityResolution | undefined {
  switch (result.kind) {
    case 'resolved':
      refs[refKey] = result.candidate.id;
      return undefined;
    case 'ambiguous':
      return {
        status: 'ambiguous',
        refs,
        ambiguous: { entityKind, reference, candidates: result.candidates },
      };
    case 'not_found':
      return {
        status: 'not_found',
        refs,
        notFound: { entityKind, reference },
      };
    case 'skipped':
      // Kind unsupported / empty reference — nothing to resolve, and NOT a
      // guess. Leave the ref absent; the proposal surfaces for operator review.
      return undefined;
  }
}

export async function resolveSchedulingEntities(
  resolver: EntityResolver | undefined,
  tenantId: string,
  intent: string,
  entities: Record<string, unknown>,
): Promise<SchedulingEntityResolution> {
  const refs: Record<string, string> = {};

  // Deterministic natural-language datetime → concrete UTC window. This is a
  // PARSE of the caller's own words, not an identity guess, so it stays inline.
  const dt = typeof entities.dateTimeDescription === 'string'
    ? entities.dateTimeDescription
    : typeof entities.datetime === 'string' ? entities.datetime : undefined;
  if (dt && typeof entities.scheduledStart !== 'string') {
    const win = parseNaturalDatetime(dt);
    if (win) {
      refs.scheduledStart = win.scheduledStart;
      refs.scheduledEnd = win.scheduledEnd;
    }
  }

  // ── Customer ────────────────────────────────────────────────────────────
  // Explicit uuid wins; otherwise resolve the free-text name through the
  // resolver. Generic references ("our customer") carry no identity and are
  // never resolved.
  const explicitCustomerId =
    typeof entities.customerId === 'string' && UUID_RE.test(entities.customerId)
      ? entities.customerId
      : undefined;
  if (explicitCustomerId) {
    refs.customerId = explicitCustomerId;
  } else {
    const name = typeof entities.customerName === 'string' ? entities.customerName.trim() : undefined;
    if (resolver && name && !GENERIC_CUSTOMER_REFS.has(name.toLowerCase())) {
      const result = await resolver.resolve({ tenantId, reference: name, kind: 'customer' });
      const terminal = foldResolution(result, 'customer', name, refs, 'customerId');
      if (terminal) return terminal;
    }
  }

  // ── Job (create intents) ─────────────────────────────────────────────────
  if (SCHEDULING_CREATE_INTENTS.has(intent)) {
    const explicitJobId =
      typeof entities.jobId === 'string' && UUID_RE.test(entities.jobId) ? entities.jobId : undefined;
    if (explicitJobId) {
      refs.jobId = explicitJobId;
    } else {
      const jobRef = typeof entities.jobReference === 'string' ? entities.jobReference.trim() : undefined;
      if (resolver && jobRef) {
        const result = await resolver.resolve({ tenantId, reference: jobRef, kind: 'job' });
        const terminal = foldResolution(result, 'job', jobRef, refs, 'jobId');
        if (terminal) return terminal;
      }
      // No jobReference → nothing to resolve. We do NOT fall back to "most
      // recent active job" — that was a silent guess. jobId stays absent and
      // the proposal surfaces for operator review.
    }
  }

  // ── Appointment (cancel / reschedule / confirm / reassign) ───────────────
  if (APPOINTMENT_REF_INTENTS.has(intent)) {
    const explicitApptId =
      typeof entities.appointmentId === 'string' && UUID_RE.test(entities.appointmentId)
        ? entities.appointmentId
        : undefined;
    if (explicitApptId) {
      refs.appointmentId = explicitApptId;
    } else {
      const apptRef = typeof entities.appointmentReference === 'string'
        ? entities.appointmentReference.trim()
        : undefined;
      if (resolver && apptRef) {
        const result = await resolver.resolve({ tenantId, reference: apptRef, kind: 'appointment' });
        const terminal = foldResolution(result, 'appointment', apptRef, refs, 'appointmentId');
        if (terminal) return terminal;
      }
      // No appointmentReference → nothing to resolve. We do NOT fall back to
      // "next upcoming / most recent appointment" — that was a silent guess.
    }
    // The cancellation handler requires a reason. Use the classifier's when
    // present; otherwise record the channel — the operator sees the full
    // summary at approval time. (A default reason string is not an identity
    // guess.)
    if (intent === 'cancel_appointment' && typeof entities.reason !== 'string') {
      refs.reason = 'Requested by caller via voice session';
    }
  }

  return { status: 'resolved', refs };
}
