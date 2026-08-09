/**
 * Lookup dispatch for the IN-APP ASSISTANT surface (`POST /api/assistant/chat`).
 *
 * WHY THIS EXISTS
 * ---------------
 * Fifteen `lookup_*` skills shipped and run in production on the INBOUND
 * PHONE path, but `ai_runs` had ZERO rows with `task_type ILIKE '%lookup%'
 * OR model = 'data-lookup'` — ever. The reason: none of them were reachable
 * from `/api/assistant/chat`, which is where BOTH the mic button and typed
 * input land (`AssistantPage.tsx` posts the transcript to the same endpoint
 * with `inputMode: 'voice'`). Every lookup question classified to a
 * `lookup_*` intent, matched nothing in the route's proposal/chain dispatch
 * maps, and fell through to a generic LLM with no DB access and no tool use
 * — which answered from nothing.
 *
 * THE SEAM
 * --------
 * This module does NOT contain a lookup switch. It is a thin surface
 * adapter over `workers/voice-lookup-answer.ts#executeLookupAnswer` — the
 * per-skill dispatch that already existed and that the recorded-memo worker
 * already calls. One implementation, two callers. Copying the telephony
 * adapter's `runLookupSkill` switch in here is exactly the mistake that
 * produced three drifted copies of `intentToProposalType`.
 *
 * What lives here (and ONLY here) is genuinely surface-specific:
 *   1. Reference resolution. The phone path gets `session.customerId` free
 *      from caller-ID: the caller IS the customer. Chat has no caller — the
 *      OPERATOR asks ABOUT a customer ("what does Henderson owe me?"), so a
 *      free-text `customerName` / `jobReference` must go through the
 *      `EntityResolver` first. Ambiguity returns a "which one?" answer
 *      listing the candidates; not-found falls through to the shared
 *      module's honest "I couldn't find a customer matching …".
 *   2. The authorization model. The phone path gates owner lookups on
 *      `ownerSession` (caller-ID identity) AND `extendedIntents` (a tenant
 *      opt-in whose real job is keeping the TELEPHONY classifier prompt
 *      byte-identical for cassette hashes, and keeping an anonymous caller
 *      away from owner reports). Neither applies to a signed-in operator on
 *      their own dashboard. Chat instead uses the DB-authoritative RBAC gate
 *      the shared module already enforces (`LOOKUP_REQUIRED_PERMISSION` —
 *      `reports:view` for the owner reports, `settings:view` for the
 *      catalog, `customers:view` for leads), which fails CLOSED — a
 *      technician asking for revenue gets the refusal copy, not data.
 *   3. Response shape + failure copy. The phone path speaks a TTS string and
 *      degrades every error to "let me get a person to help". Chat returns
 *      the assistant envelope and must make a failure VISIBLE rather than
 *      silently reverting to the generic LLM — a fluent hallucination is
 *      worse than an honest "I couldn't pull that up".
 */
import { v4 as uuidv4 } from 'uuid';
import type { IntentType } from './intent-classifier';
import type { EntityCandidate, EntityResolver } from '../resolution/entity-resolver';
import {
  executeLookupAnswer,
  CUSTOMER_SCOPED_LOOKUP_INTENTS,
  LOOKUP_REQUIRED_PERMISSION,
  type SharedLookupRepos,
  type VoiceLookupAnswerDeps,
} from '../../workers/voice-lookup-answer';
import { TECHNICIAN_REF_INTENTS } from '../agents/customer-calling/entity-resolution';

/**
 * Everything the assistant route needs to answer a lookup, as ONE optional
 * bundle so `AssistantRouterDeps` doesn't grow ten sibling repo fields.
 * `answers` + `shared` are the exact structures the recorded-memo worker is
 * wired with — app.ts builds them once and passes the SAME objects to both.
 */
export interface AssistantLookupDeps {
  answers: VoiceLookupAnswerDeps;
  shared: SharedLookupRepos;
  /**
   * Resolves the operator's free-text customer / job references. Absent
   * (in-memory mode, no pool) → customer-scoped lookups answer with the
   * "which customer?" clarification instead of guessing.
   */
  entityResolver?: EntityResolver;
  /** Tenant IANA timezone for date rendering; failure-soft. */
  tenantTimezoneResolver?: (tenantId: string) => Promise<string | undefined>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/** The assistant-chat reply envelope (same shape the route's other paths return). */
export interface AssistantLookupReply {
  taskType: string;
  model: string;
  usage: { input: number; output: number; total: number };
  degraded?: boolean;
  fallbackStage?: string;
  message: { role: 'assistant'; content: string; reasoning?: string };
}

/**
 * `model: 'data-lookup'` is the marker `answerUnpaidInvoicesQuery` already
 * uses and the one the production evidence query keys on
 * (`… OR model='data-lookup'`). Keeping it means the "did a lookup ever
 * run?" query starts returning rows the moment this ships.
 */
export const LOOKUP_MODEL = 'data-lookup';

/** `assistant.lookup.<intent>` also matches `task_type ILIKE '%lookup%'`. */
export function lookupTaskType(intent: IntentType): string {
  return `assistant.lookup.${intent}`;
}

/**
 * The human-readable "your ___" subject for copy like "I couldn't pull up
 * your ___ just now". The generic derivation (strip `lookup_`, underscores
 * → spaces) reads fine for most intents ("your crew schedule", "your
 * timesheets") but `lookup_my_day` → "my day" doubles the possessive
 * ("your my day") — spec-review addendum. Special-cased rather than
 * generalizing the strip rule, since every other intent's derived subject
 * is correct as-is.
 */
function lookupSubject(intent: IntentType): string {
  if (intent === 'lookup_my_day') return 'day';
  return intent.replace(/^lookup_/, '').replace(/_/g, ' ');
}

/**
 * Chat-specific copy for a customer-scoped ask with NO reference at all.
 * The shared module's default ("Say which customer you mean") is written for
 * a caller who IS the customer; an operator typing "what appointments do I
 * have tomorrow?" means their own day, so point them at the phrasing that
 * actually answers that instead of dead-ending them.
 */
function noCustomerReferenceReply(intent: IntentType): AssistantLookupReply {
  return {
    taskType: lookupTaskType(intent),
    model: LOOKUP_MODEL,
    usage: { input: 0, output: 0, total: 0 },
    message: {
      role: 'assistant',
      content:
        "Which customer do you mean? Tell me their name — for example, \"what does Henderson owe me?\". " +
        'If you meant your own schedule, ask "what does my day look like?" instead.',
      reasoning:
        'Customer-scoped lookup with no customer reference — asked rather than guessing a customer.',
    },
  };
}

function ambiguousReply(
  intent: IntentType,
  reference: string,
  candidates: EntityCandidate[],
): AssistantLookupReply {
  const list = candidates
    .slice(0, 5)
    .map((c) => c.label)
    .join('; ');
  return {
    taskType: lookupTaskType(intent),
    model: LOOKUP_MODEL,
    usage: { input: 0, output: 0, total: 0 },
    message: {
      role: 'assistant',
      content: `More than one match for "${reference}": ${list}. Which one did you mean?`,
      reasoning: 'Entity reference was ambiguous — asked instead of guessing (never a silent pick).',
    },
  };
}

/**
 * Resolve one free-text reference. Read-only lookups accept the
 * `low_confidence` band (the voice write path forces a confirm turn there
 * because it is about to MUTATE; showing an operator their own tenant's
 * probably-right record is not the same risk). `ambiguous` still asks.
 */
async function resolveReference(
  resolver: EntityResolver | undefined,
  tenantId: string,
  reference: string | undefined,
  kind: 'customer' | 'job' | 'technician',
): Promise<
  | { kind: 'resolved'; id: string }
  | { kind: 'ambiguous'; candidates: EntityCandidate[] }
  | { kind: 'unresolved' }
> {
  if (!resolver || !reference || reference.trim().length === 0) return { kind: 'unresolved' };
  const result = await resolver.resolve({ tenantId, reference, kind });
  if (result.kind === 'resolved' || result.kind === 'low_confidence') {
    return { kind: 'resolved', id: result.candidate.id };
  }
  if (result.kind === 'ambiguous') return { kind: 'ambiguous', candidates: result.candidates };
  return { kind: 'unresolved' };
}

export interface DispatchAssistantLookupInput {
  tenantId: string;
  /** Authenticated operator — the authz subject for owner-grade lookups. */
  userId: string;
  intent: IntentType;
  extractedEntities?: Record<string, unknown>;
}

/**
 * Execute a `lookup_*` intent for the assistant-chat surface.
 *
 * Returns `null` ONLY when this intent has no wired skill on this surface
 * (a deployment missing the repos for it) — the caller then keeps today's
 * fall-through. Every other outcome, INCLUDING
 * a skill failure, returns a reply: a lookup must never silently become a
 * generic LLM answer, because that is precisely how "it isn't pulling up the
 * information I'm asking for" looks to an operator.
 *
 * NEVER THROWS. The assistant route's intent block is wrapped in a bare
 * `try { … } catch { }` that swallows everything into the generic LLM path;
 * this function converting its own failures into a visible reply is what
 * keeps a lookup from disappearing down that hole.
 */
export async function dispatchAssistantLookup(
  input: DispatchAssistantLookupInput,
  deps: AssistantLookupDeps,
): Promise<AssistantLookupReply | null> {
  const { tenantId, userId, intent } = input;
  const entities = input.extractedEntities ?? {};

  try {
    const customerReference =
      typeof entities.customerName === 'string' ? entities.customerName : undefined;
    const jobReference =
      typeof entities.jobReference === 'string' ? entities.jobReference : undefined;
    // Task 10 (2026-08-07 tradesperson plan) — lookup_crew_schedule /
    // lookup_timesheets name a crew member the SAME way reassign_appointment
    // does (targetTechnicianName); dateTimeDescription is the raw spoken
    // day/window phrase lookup_crew_schedule resolves internally.
    //
    // Gated on TECHNICIAN_REF_INTENTS (spec-review addendum) — the SAME
    // set the memo path's entity-resolution reaches via
    // planVoiceEntityLookups. Without this gate, ANY lookup intent's
    // extractedEntities.targetTechnicianName would trigger a resolver
    // query here, including on lookup_my_day: a wasted query on an intent
    // that never reads the result (see voice-lookup-answer.ts's
    // `lookup_my_day` case, which resolves the SPEAKER, never
    // input.technicianId), and on an ambiguous name it would return a
    // list of crew members' full names for the one lookup intent with NO
    // permission gate.
    const technicianReference =
      TECHNICIAN_REF_INTENTS.has(intent) && typeof entities.targetTechnicianName === 'string'
        ? entities.targetTechnicianName
        : undefined;
    const dateTimeDescription =
      typeof entities.dateTimeDescription === 'string' ? entities.dateTimeDescription : undefined;

    // Customer-scoped ask with nothing to resolve → chat-specific clarification.
    if (CUSTOMER_SCOPED_LOOKUP_INTENTS.has(intent) && !customerReference) {
      return noCustomerReferenceReply(intent);
    }

    let customerId: string | undefined;
    if (customerReference) {
      const resolved = await resolveReference(
        deps.entityResolver,
        tenantId,
        customerReference,
        'customer',
      );
      if (resolved.kind === 'ambiguous') {
        return ambiguousReply(intent, customerReference, resolved.candidates);
      }
      if (resolved.kind === 'resolved') customerId = resolved.id;
    }

    let jobId: string | undefined;
    if (jobReference) {
      const resolved = await resolveReference(deps.entityResolver, tenantId, jobReference, 'job');
      if (resolved.kind === 'ambiguous') {
        return ambiguousReply(intent, jobReference, resolved.candidates);
      }
      if (resolved.kind === 'resolved') jobId = resolved.id;
    }

    let technicianId: string | undefined;
    if (technicianReference) {
      const resolved = await resolveReference(
        deps.entityResolver,
        tenantId,
        technicianReference,
        'technician',
      );
      if (resolved.kind === 'ambiguous') {
        return ambiguousReply(intent, technicianReference, resolved.candidates);
      }
      if (resolved.kind === 'resolved') technicianId = resolved.id;
    }

    const timezone = deps.tenantTimezoneResolver
      ? await deps.tenantTimezoneResolver(tenantId).catch(() => undefined)
      : undefined;

    const execution = await executeLookupAnswer(
      {
        tenantId,
        // Per-turn UUID: lookup_events.session_id is a UUID column, and the
        // route's correlation id (`assistant-<userId>-<uuid>`) is not one.
        sessionId: uuidv4(),
        intent,
        actorId: userId,
        ...(customerId ? { customerId } : {}),
        ...(jobId ? { jobId } : {}),
        ...(customerReference ? { customerReference } : {}),
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

    // Not an E-lane intent, or its repos aren't wired in this deployment.
    if (execution.kind === 'unsupported') return null;

    if (execution.kind === 'failed') {
      return failureReply(intent, execution.error);
    }

    // 'found' | 'none' | 'refused' all carry an accurate, data-derived
    // summary. A zero-row lookup returns the skill's real empty answer
    // ("You have no appointments scheduled") — never a fluent invention.
    return {
      taskType: lookupTaskType(intent),
      model: LOOKUP_MODEL,
      usage: { input: 0, output: 0, total: 0 },
      message: {
        role: 'assistant',
        content: execution.answer.summary,
        reasoning:
          execution.answer.result === 'refused'
            ? `Permission-gated lookup refused — your role lacks ${
                LOOKUP_REQUIRED_PERMISSION.get(intent) ?? 'the required permission'
              }.`
            : `Answered from your ${lookupSubject(intent)} records (read-only lookup).`,
      },
    };
  } catch (err) {
    // Belt-and-braces: executeLookupAnswer already catches skill failures,
    // but resolver / timezone / role reads happen out here. Surfacing the
    // failure keeps it out of the route's swallowing catch.
    return failureReply(intent, err instanceof Error ? err.message : String(err));
  }
}

/**
 * A VISIBLE failure. The operator is told the lookup failed rather than
 * being handed a confident-sounding LLM answer assembled from nothing.
 * `degraded: true` also marks the turn in the response envelope.
 */
export function failureReply(intent: IntentType, error: string): AssistantLookupReply {
  const subject = lookupSubject(intent);
  return {
    taskType: lookupTaskType(intent),
    model: LOOKUP_MODEL,
    usage: { input: 0, output: 0, total: 0 },
    degraded: true,
    fallbackStage: 'lookup-failed',
    message: {
      role: 'assistant',
      content: `I couldn't pull up your ${subject} just now — that lookup failed. Try again in a moment, and if it keeps failing let support know.`,
      reasoning: `Lookup skill failed: ${error}`,
    },
  };
}
