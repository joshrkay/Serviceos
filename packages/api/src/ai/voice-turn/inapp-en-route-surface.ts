/**
 * en_route surface adapter for IN-APP VOICE (#847 / SCH-D4).
 *
 * THE SEAM — the exact shape of `phone-en-route-surface.ts` next door, and
 * for the same reason: this module contains NO resolution and NO dispatch
 * logic. It is the in-app adapter's thin caller of
 * `dispatch/en-route-voice.ts#handleEnRouteForTechnician` — the
 * technician-scoped core the recorded-memo wrapper
 * (`handleEnRouteVoiceIntent`), both phone transports
 * (`phone-en-route-surface.ts`) and the chat branch (`routes/assistant.ts`)
 * already drive. Adding a surface means adding a CALLER, never copying the
 * resolve-then-act flow.
 *
 * `proposals/voice-intent-map.ts` states the invariant this closes: `en_route`
 * is deliberately absent from the intent→proposalType map because it is a
 * DIRECT status act, so "every live surface must intercept it BEFORE reaching
 * that map's lookup — an intent that falls through there silently becomes a
 * clarification card." In-app was the last live surface with no branch, so
 * "On my way to the Garcia job" — spoken by the technician standing in the
 * driveway, on the surface they are most likely holding — minted a dead
 * `voice_clarification` and told them it was taken care of.
 *
 * What lives here (and ONLY here) is genuinely in-app-specific:
 *
 *   1. IDENTITY. The actor is the AUTHENTICATED session user
 *      (`session.actorUserId`, stamped from `req.auth.userId` at
 *      `InAppVoiceAdapter.startSession`), resolved to a canonical `users`
 *      row via `resolveCanonicalUser` — the same dual-check (clerk subject
 *      OR users.id) the chat branch uses, because this surface carries the
 *      same kind of subject.
 *
 *      NO `role === 'technician'` GATE, unlike the phone and SMS legs. That
 *      gate is an ANTI-SPOOFING rule: those surfaces identify the actor by a
 *      caller-ID / sender number, which is asserted by the network and can
 *      be spoofed, so they refuse to fire an outbound customer-facing ETA
 *      for anyone but a technician. In-app identity is an authenticated
 *      session (Clerk), not a phone number — there is nothing to spoof. The
 *      real scope guard is the core's own: it only ever reads THIS user's
 *      assignments (`assignmentRepo.findByTechnician`), so an owner or
 *      dispatcher who is genuinely assigned to today's visit can say "on my
 *      way" (small shops run exactly this way, and `resolveTechnician`
 *      already treats owner/dispatcher/technician alike as assignable),
 *      while anyone NOT on the job simply has no assignment and hears the
 *      honest "nothing to mark en route" answer. Refusing an assigned owner
 *      would be the dishonest outcome, and widening past their own
 *      assignments is impossible from here.
 *
 *   2. Response copy. The core's `answer.summary` is already the speakable
 *      sentence. The failure lines differ from the phone's: an in-app
 *      operator has a screen and an en-route button, so "use the button"
 *      is a real recovery — "let me get a person to help" (the phone copy)
 *      would be a lie on a surface with nobody to transfer to.
 *
 *   3. Telemetry. `en_route_executed` on the session bus for EVERY outcome,
 *      same vocabulary as the phone surface so one dashboard reads both.
 *
 * FSM CONTRACT (same as the lookup surface): the CALLER must not dispatch
 * `intent_classified` for `en_route` — the turn stays in `intent_capture`,
 * mints nothing, and the next utterance is captured normally.
 */
import { createLogger } from '../../logging/logger';
import type {
  VoiceSession,
  VoiceSessionEvent,
} from '../agents/customer-calling/voice-session-store';
import { ambiguousReferenceLine } from '../orchestration/lookup-reference';
import { enRouteExecutedEvent } from '../voice-quality/events';
import type { UserRepository } from '../../users/user';
import { resolveCanonicalUser } from '../../users/user';
import {
  handleEnRouteForTechnician,
  technicianNameIfKnown,
  type EnRouteTechnicianDeps,
} from '../../dispatch/en-route-voice';

/**
 * ONE optional bundle on the adapter deps (precedent: `PhoneEnRouteDeps`,
 * `AssistantEnRouteDeps`), not seven sibling repo fields.
 * `EnRouteTechnicianDeps` is everything the shared core needs; `userRepo` is
 * this surface's own — it resolves the authenticated session subject to a
 * canonical user row.
 */
export interface InAppEnRouteDeps extends EnRouteTechnicianDeps {
  userRepo?: Pick<UserRepository, 'findByTenant'>;
}

export interface InAppEnRouteInput {
  session: VoiceSession;
  tenantId: string;
  /** The classifier's extractedEntities for this turn (may be empty). */
  entities?: Record<string, unknown>;
}

/** Spoken when the deployment lacks the bundle/repos, or the act threw. */
export const INAPP_EN_ROUTE_UNAVAILABLE_LINE =
  "I couldn't send an on-my-way text just now, so nothing went out. Use the en-route button on the appointment instead.";
/**
 * Spoken when the tenant's timezone is unset: "today" is undefined, and a
 * UTC fallback could text tomorrow's customer (Phoenix postmortem). A
 * cannot-answer, never a guess — and in-app the operator can fix it.
 */
export const INAPP_EN_ROUTE_NO_TIMEZONE_LINE =
  "I can't tell which of your appointments is today because this workspace has no timezone set, so nothing was sent. Set the business timezone in Settings and try again.";
/**
 * The session subject didn't resolve to a team member — an IDENTITY outcome,
 * not an authorization one.
 */
export const INAPP_NO_ACTOR_EN_ROUTE_LINE =
  "I couldn't match your account to a team member, so I didn't send an on-my-way text.";

const logger = createLogger({
  service: 'voice.inapp-en-route-surface',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * Fire "on my way" for one in-app voice turn. Returns the line to speak;
 * NEVER throws, and never mints a proposal.
 */
export async function answerInAppEnRoute(
  deps: InAppEnRouteDeps | undefined,
  input: InAppEnRouteInput,
): Promise<string> {
  const { session, tenantId } = input;
  const entities = input.entities ?? {};
  const startMs = Date.now();
  const emit = (
    outcome: Extract<VoiceSessionEvent, { type: 'en_route_executed' }>['outcome'],
    error?: string,
  ) =>
    session.events.emit(
      'voice-event',
      enRouteExecutedEvent(outcome, Date.now() - startMs, error),
    );

  if (!deps || !deps.userRepo) {
    logger.warn('in-app en_route requested but the bundle is not wired — deployment wiring gap', {
      tenantId,
      sessionId: session.id,
      missing: deps ? 'userRepo' : 'bundle',
    });
    emit('unavailable', 'not_wired');
    return INAPP_EN_ROUTE_UNAVAILABLE_LINE;
  }

  try {
    // Identity first (D-026 default-deny): no resolvable actor → say so.
    if (!session.actorUserId) {
      emit('refused', 'no_actor');
      return INAPP_NO_ACTOR_EN_ROUTE_LINE;
    }
    const actor = await resolveCanonicalUser(deps.userRepo, tenantId, session.actorUserId);
    if (!actor) {
      emit('refused', 'unknown_actor');
      return INAPP_NO_ACTOR_EN_ROUTE_LINE;
    }

    const jobReference =
      typeof entities.jobReference === 'string' && entities.jobReference.trim().length > 0
        ? entities.jobReference.trim()
        : undefined;
    const technicianName = technicianNameIfKnown(actor);

    const outcome = await handleEnRouteForTechnician(deps, {
      tenantId,
      technicianId: actor.id,
      ...(technicianName ? { technicianName } : {}),
      ...(jobReference ? { jobReference } : {}),
    });

    if (outcome.kind === 'unavailable') {
      if (outcome.reason === 'no_timezone') {
        emit('unavailable', 'no_timezone');
        return INAPP_EN_ROUTE_NO_TIMEZONE_LINE;
      }
      logger.warn('in-app en_route unavailable — the core lacks wired repos in this deployment', {
        tenantId,
        sessionId: session.id,
        reason: outcome.reason,
      });
      emit('unavailable', outcome.reason);
      return INAPP_EN_ROUTE_UNAVAILABLE_LINE;
    }
    if (outcome.kind === 'ambiguous') {
      // Two of the operator's own visits match the spoken reference — the
      // shared one-tap line, never a guess about which customer gets texted.
      emit('ambiguous');
      return ambiguousReferenceLine(outcome.reference, outcome.candidates);
    }
    // 'answered' — found (the act fired) or none (explicit "nothing today").
    if (outcome.answer.result === 'found') {
      emit('sent');
      // The core's summary is the TRUTH about the customer text ("Sent the
      // customer an on-my-way text." vs "Marked you en route — no customer
      // text was sent (no reachable contact on file)."), so it is spoken
      // verbatim rather than re-worded here — re-wording it is how a surface
      // ends up claiming a text that never went out. The lead-in states what
      // was recorded, which is the half the operator asked for and the half
      // that is true either way.
      return `You're marked en route. ${outcome.answer.summary}`;
    }
    emit('no_appointment');
    return outcome.answer.summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('in-app en_route threw', {
      tenantId,
      sessionId: session.id,
      error: message,
    });
    emit('unavailable', message);
    return INAPP_EN_ROUTE_UNAVAILABLE_LINE;
  }
}
