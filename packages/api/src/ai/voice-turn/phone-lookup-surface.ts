/**
 * Lookup surface adapter for the LIVE PHONE (#866, closes #843).
 *
 * THE SEAM
 * --------
 * This module contains NO lookup switch. It is the phone's thin caller of
 * `workers/voice-lookup-answer.ts#executeLookupAnswer` — the one per-skill
 * dispatch the recorded-memo worker and the assistant chat already use. The
 * phone used to carry its own 14-case copy (`lookup-skill-runner.ts`, now
 * deleted); five intents had no case and answered "let me get a person",
 * and nothing fired a metric. Adding a surface means adding a caller, NOT
 * copying the switch.
 *
 * What lives here (and ONLY here) is genuinely phone-specific:
 *   1. Identity. The caller IS the customer for customer-scoped lookups
 *      (`session.customerId` from caller-ID identification), and the
 *      ACTOR is `session.actorUserId`, resolved once at session
 *      establishment (`telephony/phone-actor.ts`). The shared module's
 *      RBAC gate does the authorising — there is no ownerSession /
 *      extendedIntents check at dispatch any more. The tenant flag still
 *      decides whether the classifier OFFERS the owner-extended intents;
 *      that is a prompt-hash concern, and this is defence in depth behind it.
 *      One phone-only rule sits on top of the shared gate, and it is an
 *      ALLOWLIST: with NO resolved actor you get the caller's OWN records
 *      (CUSTOMER_SCOPED_LOOKUP_INTENTS) and tenant-public lookups
 *      (PHONE_PUBLIC_LOOKUP_INTENTS) — nothing else. It is phrased as
 *      default-deny rather than as a list of owner-extended intents because
 *      two intents carry no permission entry ON PURPOSE
 *      (`lookup_day_overview`, `lookup_materials`: any signed-in operator may
 *      hear them on memo/chat), and this is the one surface whose caller may
 *      be a customer. A new lookup intent is therefore refused until someone
 *      decides it is safe, instead of leaking on the day it ships.
 *   2. Reference resolution. Job / crew-member / day references the
 *      classifier extracted go through the SAME shared resolver chat uses
 *      (`lookup-reference.ts`). A spoken customer NAME is deliberately not
 *      resolved here — on the phone the caller is the customer; an owner
 *      asking about a customer by name is the map's open "entity resolution
 *      per surface" question and lands in this file if/when decided.
 *   3. Response shape + failure copy. The answer's `summary` is already the
 *      TTS-ready sentence; refusals are spoken as-is. `failed` and
 *      `unsupported` speak LOOKUP_UNAVAILABLE_LINE — and `unsupported` on the
 *      phone is a deployment wiring gap, so it also logs.
 *   4. Telemetry. `lookup_executed` on the session bus for EVERY outcome
 *      (answered / refused / failed / unsupported / ambiguous), so a dead
 *      lookup is a metric, not an audit finding. `success` means "the lookup
 *      ran and answered the question" — a data-derived empty answer ("no
 *      invoices on file") counts, exactly as the pre-#866 runner counted it.
 *      A refusal, an ambiguity question and an unidentified caller are all
 *      `success: false` with a reason, because none of them answered the
 *      question that was asked.
 *
 * TRANSPORT-NEUTRAL BY DESIGN. Input is a session + intent + entities; output
 * is a line to speak. Gather calls it today; media-streams' `speechTurn` calls
 * the same function when #860 step 2 lands (held on #838 Q2). Nothing here
 * knows which transport it serves.
 *
 * FSM CONTRACT (unchanged). The CALLER must not dispatch `intent_classified`
 * for a lookup — the turn stays in `intent_capture` so the next utterance can
 * be another question.
 */
import { createLogger } from '../../logging/logger';
import type { VoiceSession } from '../agents/customer-calling/voice-session-store';
import type { IntentType } from '../orchestration/intent-classifier';
import { TECHNICIAN_REF_INTENTS } from '../agents/customer-calling/entity-resolution';
import { ambiguousReferenceLine, resolveLookupReference } from '../orchestration/lookup-reference';
import type { EntityResolver } from '../resolution/entity-resolver';
import { lookupExecutedEvent } from '../voice-quality/events';
import {
  CUSTOMER_SCOPED_LOOKUP_INTENTS,
  executeLookupAnswer,
  refusalSummary,
  type SharedLookupRepos,
  type VoiceLookupAnswerDeps,
} from '../../workers/voice-lookup-answer';

/** Same shape as the chat adapter's bundle — app.ts builds ONE and hands it to every surface. */
export interface PhoneLookupDeps {
  answers: VoiceLookupAnswerDeps;
  shared: SharedLookupRepos;
  entityResolver?: EntityResolver;
  /** Tenant IANA timezone for spoken dates; failure-soft. */
  tenantTimezoneResolver?: (tenantId: string) => Promise<string | undefined>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface PhoneLookupInput {
  session: VoiceSession;
  tenantId: string;
  intent: IntentType;
  /** The classifier's extractedEntities for this turn (may be empty). */
  entities?: Record<string, unknown>;
}

/** Spoken when the skill failed, the deployment lacks the repos, or no bundle is wired. Unchanged from the old runner. */
export const LOOKUP_UNAVAILABLE_LINE =
  "I'm having trouble pulling that up right now. Let me get a person to help.";
/** Spoken for a customer-scoped ask from a caller identification never resolved. Unchanged from the old runner. */
export const UNIDENTIFIED_CALLER_LINE =
  "I can't pull up your account without identifying you first. Let me get a person to help.";
/**
 * Tenant-public on the phone: a customer may legitimately ask this, so it is
 * the one lookup an actor-less caller still gets. Everything else is
 * default-deny (see the guard in `answerPhoneLookup`).
 */
const PHONE_PUBLIC_LOOKUP_INTENTS: ReadonlySet<IntentType> = new Set<IntentType>([
  'lookup_availability',
]);
/**
 * `lookup_my_day` with no actor is an IDENTITY outcome, not an authorization
 * one — "that's an owner-level report" would be a lie to a technician whose
 * number simply isn't on the roster. Say what actually went wrong.
 */
export const NO_ACTOR_MY_DAY_LINE =
  "I couldn't match your number to a team member, so I can't read your day. Let me get a person to help.";

const logger = createLogger({
  service: 'voice.phone-lookup-surface',
  environment: process.env.NODE_ENV || 'development',
});

function str(entities: Record<string, unknown>, key: string): string | undefined {
  const v = entities[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export async function answerPhoneLookup(
  deps: PhoneLookupDeps | undefined,
  input: PhoneLookupInput,
): Promise<string> {
  const { session, tenantId, intent } = input;
  const entities = input.entities ?? {};
  const startMs = Date.now();
  const emit = (success: boolean, error?: string) =>
    session.events.emit('voice-event', lookupExecutedEvent(intent, Date.now() - startMs, success, error));

  if (!deps) {
    logger.warn('phone lookup requested but no lookups bundle is wired — deployment wiring gap', {
      tenantId,
      sessionId: session.id,
      intent,
    });
    emit(false, 'unsupported');
    return LOOKUP_UNAVAILABLE_LINE;
  }

  try {
    const customerId = session.customerId;
    if (CUSTOMER_SCOPED_LOOKUP_INTENTS.has(intent) && !customerId) {
      // Defensive — the FSM holds the turn in `identifying` before the lookup
      // branch is reached, so this is normally unreachable. Never leak a
      // different tenant's summary to an anonymous caller.
      emit(false, 'unidentified_caller');
      return UNIDENTIFIED_CALLER_LINE;
    }

    // Anything that is neither the caller's OWN record nor tenant-public needs a
    // resolved actor. The shared RBAC map covers most of it, but
    // lookup_day_overview and lookup_materials carry no permission entry on
    // purpose (any signed-in operator may hear them on memo/chat) — and the phone
    // is the one surface whose caller may be a customer. Default-deny, so the
    // next lookup intent added to the taxonomy cannot slip through.
    if (
      !session.actorUserId &&
      !CUSTOMER_SCOPED_LOOKUP_INTENTS.has(intent) &&
      !PHONE_PUBLIC_LOOKUP_INTENTS.has(intent)
    ) {
      emit(false, 'refused');
      return intent === 'lookup_my_day' ? NO_ACTOR_MY_DAY_LINE : refusalSummary(intent);
    }

    const jobReference = str(entities, 'jobReference');
    const technicianReference = TECHNICIAN_REF_INTENTS.has(intent)
      ? str(entities, 'targetTechnicianName')
      : undefined;
    const dateTimeDescription = str(entities, 'dateTimeDescription');

    let jobId: string | undefined;
    if (jobReference) {
      const r = await resolveLookupReference(deps.entityResolver, tenantId, jobReference, 'job');
      if (r.kind === 'ambiguous') {
        emit(false, 'ambiguous_reference');
        return ambiguousReferenceLine(jobReference, r.candidates);
      }
      if (r.kind === 'resolved') jobId = r.id;
    }

    let technicianId: string | undefined;
    if (technicianReference) {
      const r = await resolveLookupReference(deps.entityResolver, tenantId, technicianReference, 'technician');
      if (r.kind === 'ambiguous') {
        emit(false, 'ambiguous_reference');
        return ambiguousReferenceLine(technicianReference, r.candidates);
      }
      if (r.kind === 'resolved') technicianId = r.id;
    }

    const timezone = deps.tenantTimezoneResolver
      ? await deps.tenantTimezoneResolver(tenantId).catch(() => undefined)
      : undefined;

    const execution = await executeLookupAnswer(
      {
        tenantId,
        // Voice session ids are UUIDs — lookup_events.session_id is a UUID column.
        sessionId: session.id,
        intent,
        ...(session.actorUserId ? { actorId: session.actorUserId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(jobId ? { jobId } : {}),
        ...(jobReference ? { jobReference } : {}),
        ...(technicianId ? { technicianId } : {}),
        ...(technicianReference ? { technicianReference } : {}),
        ...(dateTimeDescription ? { dateTimeDescription } : {}),
        ...(timezone ? { timezone } : {}),
        now: deps.now ? deps.now() : new Date(),
      },
      deps.answers,
      deps.shared,
    );

    if (execution.kind === 'unsupported') {
      logger.warn('phone lookup unsupported — the shared dispatch has no wired skill for this intent in this deployment', {
        tenantId,
        sessionId: session.id,
        intent,
      });
      emit(false, 'unsupported');
      return LOOKUP_UNAVAILABLE_LINE;
    }
    if (execution.kind === 'failed') {
      logger.warn('phone lookup failed', { tenantId, sessionId: session.id, intent, error: execution.error });
      emit(false, execution.error);
      return LOOKUP_UNAVAILABLE_LINE;
    }
    // 'found' | 'none' | 'refused' all carry a data-derived, TTS-ready summary.
    emit(execution.answer.result !== 'refused', execution.answer.result === 'refused' ? 'refused' : undefined);
    return execution.answer.summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('phone lookup threw outside the shared dispatch (resolver / timezone)', {
      tenantId,
      sessionId: session.id,
      intent,
      error: message,
    });
    emit(false, message);
    return LOOKUP_UNAVAILABLE_LINE;
  }
}
