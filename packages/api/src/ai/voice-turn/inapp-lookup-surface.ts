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
 *   2. Point of view. The skills' summaries are written for the phone, where
 *      the caller IS the customer, so they open in the second person ("You
 *      have one open invoice"). In app the operator is asking ABOUT someone,
 *      so a customer-scoped answer is re-pointed at the resolved customer by
 *      `speakForOperator` below ("Khan Household has one open invoice") —
 *      which also tells the operator WHICH record answered.
 *   3. Telemetry. `lookup_executed` on the session bus for EVERY outcome, so
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
import {
  CUSTOMER_SCOPED_LOOKUP_INTENTS,
  LOOKUP_UNAVAILABLE_LINE,
} from '../../workers/voice-lookup-answer';

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
}

const logger = createLogger({
  service: 'voice.inapp-lookup-surface',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * Second-person openings the customer-scoped skills use, and what each
 * becomes once the LISTENER is the operator rather than the customer.
 *
 * Order matters: the negated forms are matched before the plain ones so
 * "You don't have" cannot be half-rewritten, and `Your` carries a word
 * boundary so it never eats the `You` forms.
 *
 * Everything not in this table is left EXACTLY as the skill wrote it. The
 * summaries carry money, dates and record numbers; a broad "swap pronouns"
 * regex over that is how you end up speaking a number that isn't in the
 * database. This is a copy fix, not a rewriter.
 */
const OPERATOR_VOICE_REWRITES: ReadonlyArray<{
  readonly match: RegExp;
  /** `adverb` is the captured "currently "/"still " etc., or '' when absent. */
  readonly replace: (name: string, adverb: string) => string;
}> = [
  // The adverb group is why this is a table and not four string swaps: the
  // shipped copy says "You currently owe $488.25 across 2 open invoice(s)",
  // and the verb has to inflect on the far side of the adverb.
  { match: /^You ((?:currently|now|also|still) )?don't have\b/i, replace: (n, a) => `${n} ${a}doesn't have` },
  { match: /^You ((?:currently|now|also|still) )?do not have\b/i, replace: (n, a) => `${n} ${a}does not have` },
  { match: /^You ((?:currently|now|also|still) )?have\b/i, replace: (n, a) => `${n} ${a}has` },
  { match: /^You ((?:currently|now|also|still) )?owe\b/i, replace: (n, a) => `${n} ${a}owes` },
  { match: /^Your\b/i, replace: (n) => `${n}'s` },
];

/** Sentence starts: the beginning of the summary, and after `.`/`!`/`?` + space. */
const SENTENCE_SPLIT = /(?<=[.!?]\s)/;

/**
 * Re-point a customer-scoped skill summary at the customer it is ABOUT.
 *
 * The lookup skills are shared with the live phone, where the caller IS the
 * customer, so they speak in the second person: "Your account is paid in
 * full", "You have one open invoice — INV-0042 for $488.25". Spoken back to
 * an OPERATOR who asked "what does Khan owe us?", that is wrong twice over —
 * it addresses the wrong party, and it never says which record answered, so
 * the operator cannot tell a right match from a wrong one.
 *
 * Pure and total: with no name, or a summary that opens some other way, the
 * input is returned unchanged. Rewriting happens at SENTENCE starts only, so
 * a "you" inside a sentence (a skill's advice line, a quoted note) is never
 * touched.
 */
export function speakForOperator(summary: string, customerDisplayName?: string): string {
  const name = customerDisplayName?.trim();
  if (!name) return summary;
  return summary
    .split(SENTENCE_SPLIT)
    .map((sentence) => {
      for (const { match, replace } of OPERATOR_VOICE_REWRITES) {
        if (!match.test(sentence)) continue;
        // Function replacer, not a `$1` template: a display name is tenant
        // data and could contain `$&`, which a string replacement would
        // expand into the matched text.
        return sentence.replace(match, (_full, adverb?: string) => replace(name, adverb ?? ''));
      }
      return sentence;
    })
    .join('');
}

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
 * The name to speak for the customer an answer is about.
 *
 * The resolver's own label IS the customer's `display_name` on every wired
 * resolver (PgEntityResolver selects it; AliasFirstEntityResolver reads the
 * same column), so the normal path costs no query. The repo read is the
 * fallback for a resolver that returned an id without a label, and it is
 * failure-soft: a name we cannot get means the summary is spoken unchanged,
 * never that the lookup fails.
 */
async function customerDisplayName(
  deps: AssistantLookupDeps,
  tenantId: string,
  resolved: { id: string; label?: string } | undefined,
): Promise<string | undefined> {
  if (!resolved) return undefined;
  if (resolved.label) return resolved.label;
  if (!deps.shared.customerRepo) return undefined;
  try {
    const customer = await deps.shared.customerRepo.findById(tenantId, resolved.id);
    return customer?.displayName;
  } catch {
    return undefined;
  }
}

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
    if (outcome !== 'answered' || !CUSTOMER_SCOPED_LOOKUP_INTENTS.has(intent)) {
      return reply.message.content;
    }
    return speakForOperator(
      reply.message.content,
      await customerDisplayName(deps, tenantId, reply.resolvedCustomer),
    );
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
