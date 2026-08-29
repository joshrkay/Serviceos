/**
 * en_route surface adapter for the LIVE PHONE (#847).
 *
 * THE SEAM — same shape as `phone-lookup-surface.ts` one file over: this
 * module contains NO resolution or dispatch logic. It is the phone's thin
 * caller of `dispatch/en-route-voice.ts#handleEnRouteForTechnician` — the
 * one technician-scoped core the recorded-memo wrapper and the SMS-keyword
 * leg already drive. Adding a surface means adding a caller, NOT copying
 * the resolve-then-act flow.
 *
 * What lives here (and ONLY here) is genuinely phone-specific:
 *   1. Identity. The ACTOR is `session.actorUserId`, resolved once at
 *      session establishment (`telephony/phone-actor.ts`, both transports).
 *      "On my way" is a DIRECT status act — it fires the audited
 *      `triggerEnRoute` and texts the customer — so this surface REQUIRES
 *      `role === 'technician'`, the same anti-spoofing rule the SMS-keyword
 *      leg enforces (`sms/tech-status/en-route-keyword.ts`). No resolved
 *      actor is an IDENTITY outcome, not an authorization one — same tone
 *      as NO_ACTOR_MY_DAY_LINE (D-026 default-deny, said honestly).
 *   2. Response shape + failure copy. The core's `answer.summary` is
 *      already the TTS-ready sentence; ambiguity speaks the shared
 *      `ambiguousReferenceLine` (never a guess); `unavailable` splits by
 *      reason — an unset tenant timezone is "I can't tell which
 *      appointments are today" (Phoenix postmortem: never a UTC fallback),
 *      a wiring gap is the generic unavailable line plus a logged warning.
 *   3. Telemetry. `en_route_executed` on the session bus for EVERY outcome
 *      — a dead branch is a metric, not an audit finding. (Deliberately not
 *      `lookup_executed`: this act mutates.)
 *
 * FSM CONTRACT (same as lookups): the CALLER must not dispatch
 * `intent_classified` for en_route — the turn stays in `intent_capture` so
 * the next utterance can be another ask.
 */
import { createLogger } from '../../logging/logger';
import type { VoiceSession } from '../agents/customer-calling/voice-session-store';
import { ambiguousReferenceLine } from '../orchestration/lookup-reference';
import { enRouteExecutedEvent } from '../voice-quality/events';
import type { UserRepository } from '../../users/user';
import {
  handleEnRouteForTechnician,
  technicianDisplayName,
  type EnRouteTechnicianDeps,
} from '../../dispatch/en-route-voice';

/**
 * ONE optional bundle on the adapter deps (precedent: PhoneLookupDeps), not
 * seven sibling repo fields. `EnRouteTechnicianDeps` is everything the core
 * needs; `userRepo` is the surface's own — it resolves the session actor to
 * a role-checked user row.
 */
export interface PhoneEnRouteDeps extends EnRouteTechnicianDeps {
  userRepo?: Pick<UserRepository, 'findById'>;
}

export interface PhoneEnRouteInput {
  session: VoiceSession;
  tenantId: string;
  /** The classifier's extractedEntities for this turn (may be empty). */
  entities?: Record<string, unknown>;
}

/** Spoken when the deployment lacks the bundle/repos, or the act threw. */
export const EN_ROUTE_UNAVAILABLE_LINE =
  "I can't send an on-my-way text right now. Let me get a person to help.";
/**
 * Spoken when the tenant's timezone is unset: "today" is undefined, and a
 * UTC fallback could text tomorrow's customer. Cannot-answer, never a guess.
 */
export const EN_ROUTE_NO_TIMEZONE_LINE =
  "I can't tell which of your appointments is today, so I didn't send anything. Let me get a person to help.";
/**
 * An IDENTITY outcome, not an authorization one — the caller's number simply
 * isn't matched to a team member (NO_ACTOR_MY_DAY_LINE tone).
 */
export const NO_ACTOR_EN_ROUTE_LINE =
  "I couldn't match your number to a team member, so I can't send an on-my-way text. Let me get a person to help.";
/**
 * The resolved actor exists but isn't a technician. Same anti-spoofing rule
 * as the SMS-keyword leg: the ETA text goes out under the technician on the
 * job, so only a technician may fire it.
 */
export const NOT_TECHNICIAN_EN_ROUTE_LINE =
  "On-my-way texts are sent by the technician on the job, and your number isn't matched to one. Let me get a person to help.";

const logger = createLogger({
  service: 'voice.phone-en-route-surface',
  environment: process.env.NODE_ENV || 'development',
});

export async function answerPhoneEnRoute(
  deps: PhoneEnRouteDeps | undefined,
  input: PhoneEnRouteInput,
): Promise<string> {
  const { session, tenantId } = input;
  const entities = input.entities ?? {};
  const startMs = Date.now();
  const emit = (
    outcome: 'sent' | 'no_appointment' | 'ambiguous' | 'refused' | 'unavailable',
    error?: string,
  ) =>
    session.events.emit(
      'voice-event',
      enRouteExecutedEvent(outcome, Date.now() - startMs, error),
    );

  if (!deps || !deps.userRepo) {
    logger.warn('phone en_route requested but the bundle is not wired — deployment wiring gap', {
      tenantId,
      sessionId: session.id,
      missing: deps ? 'userRepo' : 'bundle',
    });
    emit('unavailable', 'not_wired');
    return EN_ROUTE_UNAVAILABLE_LINE;
  }

  try {
    // Identity first (D-026 default-deny): no actor → refuse honestly.
    if (!session.actorUserId) {
      emit('refused', 'no_actor');
      return NO_ACTOR_EN_ROUTE_LINE;
    }
    const user = await deps.userRepo.findById(tenantId, session.actorUserId);
    if (!user || user.role !== 'technician') {
      emit('refused', user ? 'not_a_technician' : 'unknown_actor');
      return NOT_TECHNICIAN_EN_ROUTE_LINE;
    }

    const jobReference =
      typeof entities.jobReference === 'string' && entities.jobReference.trim().length > 0
        ? entities.jobReference.trim()
        : undefined;
    const technicianName = technicianDisplayName(user);

    const outcome = await handleEnRouteForTechnician(deps, {
      tenantId,
      technicianId: user.id,
      ...(technicianName ? { technicianName } : {}),
      ...(jobReference ? { jobReference } : {}),
    });

    if (outcome.kind === 'unavailable') {
      if (outcome.reason === 'no_timezone') {
        emit('unavailable', 'no_timezone');
        return EN_ROUTE_NO_TIMEZONE_LINE;
      }
      logger.warn('phone en_route unavailable — the core lacks wired repos in this deployment', {
        tenantId,
        sessionId: session.id,
        reason: outcome.reason,
      });
      emit('unavailable', outcome.reason);
      return EN_ROUTE_UNAVAILABLE_LINE;
    }
    if (outcome.kind === 'ambiguous') {
      emit('ambiguous');
      return ambiguousReferenceLine(outcome.reference, outcome.candidates);
    }
    // 'answered' — found (act fired) or none (explicit "nothing upcoming").
    emit(outcome.answer.result === 'found' ? 'sent' : 'no_appointment');
    return outcome.answer.summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('phone en_route threw', {
      tenantId,
      sessionId: session.id,
      error: message,
    });
    emit('unavailable', message);
    return EN_ROUTE_UNAVAILABLE_LINE;
  }
}
