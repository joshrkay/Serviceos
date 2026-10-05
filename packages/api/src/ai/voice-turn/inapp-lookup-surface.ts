/**
 * Lookup surface adapter for IN-APP OPERATOR VOICE (`/api/voice/sessions`).
 *
 * THE SEAM
 * --------
 * This module contains NO lookup switch and NO reference-resolution ladder.
 * It is the in-app voice surface's thin caller of
 * `ai/orchestration/lookup-dispatch.ts#dispatchAssistantLookup` — which is
 * itself the thin caller of the one per-skill dispatch
 * (`workers/voice-lookup-answer.ts#executeLookupAnswer`). Adding a surface
 * means adding a caller, never copying the switch: the phone learned that
 * the expensive way (a 14-case copy in which five intents silently answered
 * "let me get a person", #843/#866).
 *
 * WHY IT CALLS THE CHAT DISPATCH RATHER THAN THE PHONE ONE
 * --------------------------------------------------------
 * Identity, not transport, decides which adapter a surface belongs to. In
 * app, the speaker is the AUTHENTICATED OPERATOR asking ABOUT a customer
 * ("what does Khan owe?") — the same identity model as the assistant chat
 * box, and the opposite of the phone's (where the caller IS the customer and
 * `session.customerId` comes free from caller-ID). So the free-text
 * customer / job / crew reference must go through the EntityResolver, an
 * ambiguous name must become a "which one?" question, and a customer-scoped
 * ask with no name at all must become "which customer do you mean?" — all of
 * which `dispatchAssistantLookup` already does, in the copy the operator
 * already hears from the chat box. A second implementation would be a second
 * set of answers to the same question.
 *
 * What lives here (and ONLY here) is genuinely in-app-VOICE-specific:
 *   1. Speech. The reply's `message.content` is the spoken line, for every
 *      outcome — answer, refusal, which-one, which-customer, not-found, and
 *      a skill FAILURE (whose copy is already an honest, speakable "I
 *      couldn't pull that up just now — that lookup failed", which beats the
 *      phone's "let me get a person to help" on a surface where the operator
 *      IS the person). The one line that is NOT the dispatch's is for a
 *      lookup that could not run at all — no bundle wired, or the dispatch
 *      reports `unsupported`: that speaks LOOKUP_UNAVAILABLE_LINE, the same
 *      sentence the phone speaks, and LOGS, because on an authenticated
 *      operator surface it is a deployment wiring gap, not a caller problem.
 *   2. Telemetry. `lookup_executed` on the session bus for EVERY outcome, so
 *      a dead lookup is a metric rather than an audit finding. `success` is
 *      TRUE only for `outcome: 'answered'` — a refusal, a clarifying
 *      question, a not-found and an unavailable lookup all left the
 *      operator's question unanswered. (A legitimately empty answer — "you
 *      have no unpaid invoices" — is `answered`: the data said so.)
 *
 * AUTHORIZATION IS NOT DECIDED HERE. `executeLookupAnswer`'s DB-authoritative
 * RBAC gate (`LOOKUP_REQUIRED_PERMISSION`) is the authority and fails closed:
 * a technician asking for revenue hears the refusal copy, never data. That is
 * why this surface has no `ownerSession` check — the flag it used to gate on
 * described the SESSION's role claim, not the asker's permissions, and it is
 * what limited in-app voice lookups to owners answering exactly one intent.
 *
 * FSM CONTRACT. The CALLER must not dispatch `intent_classified` for a lookup
 * — the turn stays in `intent_capture`, no proposal is minted, and the next
 * utterance can be another question. `INTENT_TO_PROPOSAL_TYPE` deliberately
 * omits every `lookup_*` intent, so a lookup that reaches the FSM ends as a
 * `voice_clarification` card nobody can action — the exact failure this
 * surface exists to remove (in-app 50-case sweep, cluster "search").
 */
import { createLogger } from '../../logging/logger';
import type { VoiceSession } from '../agents/customer-calling/voice-session-store';
import type { IntentType } from '../orchestration/intent-classifier';
import {
  dispatchAssistantLookup,
  type AssistantLookupDeps,
  type AssistantLookupOutcome,
} from '../orchestration/lookup-dispatch';
import { lookupExecutedEvent } from '../voice-quality/events';
import { LOOKUP_UNAVAILABLE_LINE } from '../../workers/voice-lookup-answer';

export interface InAppLookupInput {
  session: VoiceSession;
  tenantId: string;
  /**
   * The AUTHENTICATED OPERATOR this session was started by — the authz
   * subject for the shared RBAC gate. Stamped on the session at
   * `InAppVoiceAdapter.startSession` (`session.actorUserId`). Optional
   * because voice-quality fixtures create sessions outside that path; when
   * absent, permission-gated lookups fail CLOSED to the refusal copy.
   */
  userId: string | undefined;
  intent: IntentType;
  /** The classifier's extractedEntities for this turn (may be empty). */
  entities?: Record<string, unknown>;
  /**
   * The operator's own words this turn. Read only where an entity is missing
   * — the day in "who's scheduled for tomorrow?", a document number — the
   * same way the chat surface reads its message (#1498).
   */
  transcript?: string;
}

const logger = createLogger({
  service: 'voice.inapp-lookup-surface',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * `lookup_executed.error` reasons. Deliberately the same vocabulary the
 * phone surface emits so one dashboard reads both surfaces.
 */
const ERROR_REASON: Readonly<Record<Exclude<AssistantLookupOutcome, 'answered'>, string>> = {
  not_found: 'not_found',
  ambiguous: 'ambiguous_reference',
  no_reference: 'no_customer_reference',
  refused: 'refused',
  failed: 'failed',
};

/**
 * Answer one `lookup_*` turn for an in-app voice session. Returns the line to
 * speak; NEVER throws, and never mints a proposal.
 */
export async function answerInAppLookup(
  deps: AssistantLookupDeps | undefined,
  input: InAppLookupInput,
): Promise<string> {
  const { session, tenantId, userId, intent } = input;
  const entities = input.entities ?? {};
  const startMs = Date.now();
  const emit = (success: boolean, error?: string) =>
    session.events.emit(
      'voice-event',
      lookupExecutedEvent(intent, Date.now() - startMs, success, error),
    );

  if (!deps) {
    logger.warn('in-app lookup requested but no lookups bundle is wired — deployment wiring gap', {
      tenantId,
      sessionId: session.id,
      intent,
    });
    emit(false, 'unsupported');
    return LOOKUP_UNAVAILABLE_LINE;
  }

  try {
    const reply = await dispatchAssistantLookup(
      {
        tenantId,
        // Fails closed inside the shared gate when the session carries no
        // actor (fixtures / harness sessions): a permission-gated lookup
        // refuses rather than answering as nobody.
        userId: userId ?? '',
        intent,
        ...(Object.keys(entities).length > 0 ? { extractedEntities: entities } : {}),
        ...(input.transcript ? { message: input.transcript } : {}),
        // #1604 — the session language, so a catalog-rendered answer speaks it.
        ...(session.language ? { language: session.language } : {}),
      },
      deps,
    );

    // null ONLY means "no wired skill for this intent in this deployment".
    // On an authenticated operator surface that is a wiring gap, so it logs
    // as well as speaking the honest unavailable line.
    if (!reply) {
      logger.warn(
        'in-app lookup unsupported — the shared dispatch has no wired skill for this intent in this deployment',
        { tenantId, sessionId: session.id, intent },
      );
      emit(false, 'unsupported');
      return LOOKUP_UNAVAILABLE_LINE;
    }

    const outcome: AssistantLookupOutcome =
      reply.outcome ?? (reply.degraded ? 'failed' : 'answered');
    if (outcome === 'failed') {
      logger.warn('in-app lookup failed', {
        tenantId,
        sessionId: session.id,
        intent,
        error: reply.message.reasoning,
      });
    }
    emit(outcome === 'answered', outcome === 'answered' ? undefined : ERROR_REASON[outcome]);
    // Already in the operator's point of view — the dispatch re-points a
    // customer-scoped answer at the customer (operator-point-of-view.ts).
    return reply.message.content;
  } catch (err) {
    // dispatchAssistantLookup documents that it never throws; this is the
    // belt-and-braces that keeps a surprise from becoming a dropped turn.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('in-app lookup threw outside the shared dispatch', {
      tenantId,
      sessionId: session.id,
      intent,
      error: message,
    });
    emit(false, message);
    return LOOKUP_UNAVAILABLE_LINE;
  }
}
