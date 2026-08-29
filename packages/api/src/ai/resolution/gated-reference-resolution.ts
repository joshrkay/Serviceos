/**
 * #909 — the entity-resolution loop for a DRAFTED proposal that is gated on
 * an entity id it does not have.
 *
 * ## The gap this closes
 *
 * Every reference-carrying proposal type in this repo has the same shape: a
 * required-at-execution `xId` (uuid) paired with a free-text `xReference`
 * the classifier can actually produce. The drafting handler writes the
 * reference, pushes `xId` onto `sourceContext.missingFields`, and
 * `approveProposal` (proposals/actions.ts) refuses the proposal until that
 * gate is lifted. That gate is correct and stays.
 *
 * What was missing is the thing that LIFTS it. The voice-session FSM has a
 * resolution loop (`entity_resolution` / `entity_confirm` in
 * ai/agents/customer-calling/transitions.ts) that resolves references before
 * a proposal is ever drafted, and re-asks when the reference is ambiguous.
 * The chat surface had only the pre-draft half (routes/assistant.ts's
 * `resolveVerifiedIdsForDraft`) and silently dropped ambiguity, so sixteen
 * capabilities drafted a proposal carrying only free text and stalled at
 * `ready_for_review` forever — one architectural gap, sixteen capabilities.
 *
 * ## Where this module sits
 *
 * This is the CORE, in D-026's "one core, thin adapters" sense. It is
 * surface-agnostic, does no I/O of its own beyond the injected
 * `EntityResolver`, and never persists anything — the calling adapter owns
 * identity, persistence, reply copy and telemetry. Today the chat adapter
 * (routes/assistant.ts) is its only caller; the voice surfaces keep their
 * existing pre-draft path unchanged, and can adopt this later without this
 * module changing shape.
 *
 * ## The invariant it must not break (D-004)
 *
 * Resolution NEVER approves and NEVER executes. It fills an id a human is
 * about to review and lifts only the gate that id was blocking. A proposal
 * that was `ready_for_review` stays `ready_for_review`; the human still
 * taps approve. An AMBIGUOUS reference is never guessed — it becomes ONE
 * clarification question, exactly as CLAUDE.md requires.
 */

import {
  type EntityCandidate,
  type EntityKind,
  type EntityResolver,
} from './entity-resolver';
import type { Proposal } from '../../proposals/proposal';
import { missingFieldsFor } from '../../proposals/proposal';
import { clearSatisfiedMissingFields } from '../../proposals/missing-fields';
import type { PendingEntityAmbiguity } from '../agents/customer-calling/entity-resolution';

/**
 * How one gated id field finds the free text it should be resolved from.
 *
 * `payloadFields` are read first and are the authoritative source — they are
 * what the drafting handler itself decided the reference was, and they are
 * what the operator sees on the review card. `entityFields` are the
 * classifier's raw extraction, consulted ONLY when the payload carries no
 * reference at all: several handlers write a reference key only when the
 * classifier populated one specific field, so without this fallback a
 * perfectly good name sitting in `customerName` would be invisible to the
 * loop and the gate could never lift.
 */
export interface GatedReferenceSource {
  kind: EntityKind;
  payloadFields: readonly string[];
  entityFields: readonly string[];
}

/**
 * The id fields this loop knows how to resolve, and what free text each one
 * pairs with.
 *
 * Keys are the exact strings drafting handlers push onto `missingFields`
 * (`ai/tasks/voice-extended-tasks.ts` and friends). `toTechnicianId` is
 * reassign_appointment's own name for the same thing `add_crew_member` calls
 * `technicianId`, and both are fed by the classifier's
 * `targetTechnicianName` — they are two rows here rather than one because
 * the payload key is what `missingFields` actually carries.
 *
 * A gated field ABSENT from this table is left strictly alone: the loop only
 * ever lifts a gate it resolved itself, so a `newScheduledStart` or a
 * `lineItems[0].catalogItemId` keeps blocking approval exactly as before.
 */
export const GATED_REFERENCE_SOURCES: Readonly<Record<string, GatedReferenceSource>> = {
  customerId: {
    kind: 'customer',
    payloadFields: ['customerReference'],
    entityFields: ['customerName'],
  },
  jobId: {
    kind: 'job',
    payloadFields: ['jobReference'],
    entityFields: ['jobReference', 'jobTitle'],
  },
  invoiceId: {
    kind: 'invoice',
    payloadFields: ['invoiceReference'],
    // Every invoice-doc intent reuses `jobReference` for the spoken invoice
    // reference — there is no `invoiceReference` extraction field anywhere
    // in the classifier taxonomy (see INVOICE_DOC_INTENTS's comment in
    // ai/agents/customer-calling/entity-resolution.ts).
    entityFields: ['jobReference', 'customerName'],
  },
  estimateId: {
    kind: 'estimate',
    payloadFields: ['estimateReference'],
    entityFields: ['jobReference', 'customerName'],
  },
  appointmentId: {
    kind: 'appointment',
    payloadFields: ['appointmentReference'],
    // `customerName` last, deliberately: PgEntityResolver.resolveAppointment
    // resolves a NAMED reference through the customer's jobs to their
    // appointments, so "qa-matrix-A-customer" is a usable appointment
    // reference when the classifier emitted no appointmentReference at all.
    // It is a fallback, not a preference — an explicit appointment reference
    // ("tomorrow's 3pm") always wins.
    entityFields: ['appointmentReference', 'customerName'],
  },
  technicianId: {
    kind: 'technician',
    payloadFields: ['targetTechnicianName'],
    entityFields: ['targetTechnicianName'],
  },
  toTechnicianId: {
    kind: 'technician',
    payloadFields: ['targetTechnicianName'],
    entityFields: ['targetTechnicianName'],
  },
  leadId: {
    kind: 'lead',
    payloadFields: ['leadReference'],
    entityFields: ['leadReference', 'customerName'],
  },
};

/** One gated id field plus the free text the loop will resolve it from. */
export interface GatedReferenceLookup {
  idField: string;
  kind: EntityKind;
  reference: string;
}

export interface GatedReferenceOutcome {
  /** Resolver-verified ids, keyed by the gated payload field they fill. */
  filled: Record<string, string>;
  /**
   * The FIRST ambiguity found, shaped for the disambiguation follow-up the
   * voice surface already implements (`matchDisambiguationFollowUp` /
   * `resolveDisambiguationFollowUp`). One question at a time — the operator
   * is answering in a chat box, not reading a queue.
   */
  ambiguity?: PendingEntityAmbiguity;
  /**
   * Gated fields the resolver could not answer (not_found / low_confidence /
   * no reference at all). Reported for telemetry; they keep their gate.
   */
  unresolved: string[];
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Which gated fields on this proposal are resolvable, and from what text.
 *
 * Pure and exported so the pairing can be unit-pinned without a resolver:
 * the mapping from "what is blocking approval" to "what free text answers
 * it" is the part of this loop most likely to drift as new proposal types
 * are added.
 *
 * Path-shaped gates (`lineItems[0].catalogItemId`) are skipped — they belong
 * to resolve-line's candidate picker, exactly as `clearSatisfiedMissingFields`
 * skips them.
 */
export function planGatedReferenceLookups(
  proposal: Pick<Proposal, 'payload' | 'sourceContext'>,
  entities?: Record<string, unknown>,
): GatedReferenceLookup[] {
  const payload = (proposal.payload ?? {}) as Record<string, unknown>;
  const lookups: GatedReferenceLookup[] = [];

  for (const idField of missingFieldsFor(proposal as Proposal)) {
    if (idField.includes('[') || idField.includes('.')) continue;
    const source = GATED_REFERENCE_SOURCES[idField];
    if (!source) continue;
    // Already filled (another lookup in this same pass, or the handler) —
    // nothing to resolve.
    if (trimmed(payload[idField])) continue;

    let reference: string | undefined;
    for (const field of source.payloadFields) {
      reference = trimmed(payload[field]);
      if (reference) break;
    }
    if (!reference && entities) {
      for (const field of source.entityFields) {
        reference = trimmed(entities[field]);
        if (reference) break;
      }
    }
    if (!reference) continue;

    lookups.push({ idField, kind: source.kind, reference });
  }

  return lookups;
}

function toPendingAmbiguity(
  lookup: GatedReferenceLookup,
  candidates: EntityCandidate[],
): PendingEntityAmbiguity {
  return {
    entityKind: lookup.kind,
    reference: lookup.reference,
    refKey: lookup.idField,
    // The resolver speaks `label`; the follow-up matcher speaks `name`.
    // Mapping here (rather than at each call site) is what lets the chat
    // adapter reuse `matchDisambiguationFollowUp` unchanged.
    candidates: candidates.map((c) => ({
      id: c.id,
      name: c.label,
      score: c.score,
      ...(c.hint ? { hint: c.hint } : {}),
    })),
    partialRefs: {},
    attemptCount: 0,
  };
}

/**
 * Run the resolver over every gated reference on a drafted proposal.
 *
 * Read-only with respect to the proposal — the caller applies the outcome
 * with `applyGatedReferences`, so a caller that wants to inspect before
 * committing (or to refuse the whole turn) can.
 *
 * Failure-soft by the voice worker's own convention: a resolver that throws
 * on one lookup leaves that field gated and the others unaffected. A gate
 * that stays is the status quo — a card the operator finishes by hand — so
 * degrading to it is always safe.
 */
export async function resolveGatedReferences(
  resolver: EntityResolver | undefined,
  tenantId: string,
  proposal: Pick<Proposal, 'payload' | 'sourceContext'>,
  entities?: Record<string, unknown>,
): Promise<GatedReferenceOutcome> {
  const outcome: GatedReferenceOutcome = { filled: {}, unresolved: [] };
  if (!resolver) return outcome;

  const lookups = planGatedReferenceLookups(proposal, entities);
  if (lookups.length === 0) return outcome;

  for (const lookup of lookups) {
    let result;
    try {
      result = await resolver.resolve({
        tenantId,
        reference: lookup.reference,
        kind: lookup.kind,
        // A customer resolved earlier in THIS pass anchors a later
        // appointment lookup, the same way the FSM's sticky `context.jobId`
        // does (SCH-03). Only `jobId` is a resolver input today.
        ...(outcome.filled.jobId ? { jobId: outcome.filled.jobId } : {}),
      });
    } catch {
      outcome.unresolved.push(lookup.idField);
      continue;
    }

    switch (result.kind) {
      case 'resolved':
        outcome.filled[lookup.idField] = result.candidate.id;
        break;
      case 'ambiguous':
        // ONE question per turn. The first ambiguity becomes the question;
        // any later one is simply left gated and will be asked on the next
        // pass, once this one is answered.
        if (!outcome.ambiguity) {
          outcome.ambiguity = toPendingAmbiguity(lookup, result.candidates);
        }
        outcome.unresolved.push(lookup.idField);
        break;
      case 'low_confidence':
      case 'not_found':
      case 'skipped':
        // A mid-band match is deliberately NOT auto-filled here. The voice
        // FSM answers it with a spoken one-tap confirmation turn
        // (`entity_confirm`); on a surface where the operator is looking at
        // a review card, the honest equivalent is the card they already
        // get — the gate stays and the candidate is not silently adopted.
        outcome.unresolved.push(lookup.idField);
        break;
    }
  }

  return outcome;
}

/**
 * Write resolver-verified ids onto the proposal and lift only the gates they
 * satisfy.
 *
 * Three things happen together, and they have to stay together:
 *  1. the id lands on the payload (what execution reads);
 *  2. `sourceContext.missingFields` loses exactly that key, via the shared
 *     `clearSatisfiedMissingFields` — clear-on-fill, never a schema
 *     recompute (see proposals/missing-fields.ts for why a recompute would
 *     reopen the doomed-approval bug);
 *  3. the id is recorded on `sourceContext.verifiedIds`, which is the
 *     repo's marker for "this uuid came from a DB lookup, not from a model".
 *     routes/assistant.ts's `dropUnverifiedIds` strips any id-shaped value
 *     not present in the operator's own text unless it is listed there, so
 *     without step 3 the loop's work would be scrubbed a few lines later.
 *
 * Mutates in place and returns the keys it filled. Status is untouched by
 * design (D-004): filling a field never advances a proposal toward
 * execution.
 */
export function applyGatedReferences(
  proposal: Pick<Proposal, 'payload' | 'sourceContext'>,
  filled: Record<string, string>,
): string[] {
  const keys = Object.keys(filled);
  if (keys.length === 0) return [];

  const payload = (proposal.payload ?? {}) as Record<string, unknown>;
  for (const key of keys) payload[key] = filled[key];

  const ctx = (proposal.sourceContext ?? {}) as Record<string, unknown>;
  const existingVerified =
    ctx.verifiedIds && typeof ctx.verifiedIds === 'object'
      ? (ctx.verifiedIds as Record<string, unknown>)
      : {};

  proposal.sourceContext = {
    ...ctx,
    missingFields: clearSatisfiedMissingFields(
      missingFieldsFor(proposal as Proposal),
      keys,
      payload,
    ),
    verifiedIds: { ...existingVerified, ...filled },
  };

  return keys;
}

/**
 * Record the pending question on the proposal itself.
 *
 * The chat surface has no session store — every turn is classified from
 * scratch (routes/assistant.ts). Rather than introduce one, the pending
 * clarification rides `sourceContext` on the very proposal it is blocking:
 * that row is already persisted, already tenant-scoped, already carries
 * `conversationId`, and is already the thing the answer will unblock. The
 * next turn finds it with `proposalRepo.findByConversation` — the same
 * conversation-scoped recall `IssueInvoiceTaskHandler` uses
 * (ai/orchestration/task-router.ts).
 */
export const PENDING_AMBIGUITY_KEY = 'pendingEntityAmbiguity';

export function stampPendingAmbiguity(
  proposal: Pick<Proposal, 'sourceContext'>,
  ambiguity: PendingEntityAmbiguity,
): void {
  proposal.sourceContext = {
    ...((proposal.sourceContext ?? {}) as Record<string, unknown>),
    [PENDING_AMBIGUITY_KEY]: ambiguity,
  };
}

/** Read back a pending question, if this proposal is carrying one. */
export function pendingAmbiguityOf(
  proposal: Pick<Proposal, 'sourceContext'>,
): PendingEntityAmbiguity | undefined {
  const raw = (proposal.sourceContext as Record<string, unknown> | undefined)?.[
    PENDING_AMBIGUITY_KEY
  ];
  if (!raw || typeof raw !== 'object') return undefined;
  const pending = raw as Partial<PendingEntityAmbiguity>;
  if (
    typeof pending.refKey !== 'string' ||
    typeof pending.entityKind !== 'string' ||
    !Array.isArray(pending.candidates) ||
    pending.candidates.length === 0
  ) {
    return undefined;
  }
  return {
    entityKind: pending.entityKind as EntityKind,
    reference: typeof pending.reference === 'string' ? pending.reference : '',
    refKey: pending.refKey,
    candidates: pending.candidates,
    partialRefs: pending.partialRefs ?? {},
    attemptCount: typeof pending.attemptCount === 'number' ? pending.attemptCount : 0,
  };
}

export function clearPendingAmbiguity(proposal: Pick<Proposal, 'sourceContext'>): void {
  const ctx = { ...((proposal.sourceContext ?? {}) as Record<string, unknown>) };
  delete ctx[PENDING_AMBIGUITY_KEY];
  proposal.sourceContext = ctx;
}

/**
 * Human label for a gated entity kind, used in the question copy.
 * Deliberately the operator's word, not the schema's.
 */
function kindLabel(kind: EntityKind): string {
  switch (kind) {
    case 'customer':
      return 'customer';
    case 'job':
      return 'job';
    case 'invoice':
      return 'invoice';
    case 'estimate':
      return 'estimate';
    case 'appointment':
      return 'appointment';
    case 'technician':
      return 'team member';
    case 'lead':
      return 'lead';
    default:
      return 'record';
  }
}

/** How many options a single question may list before it stops being one question. */
export const MAX_LISTED_CANDIDATES = 3;

/**
 * The ONE question the surface asks back.
 *
 * Mirrors the voice surface's `renderDisambiguation` (tts-copy.ts) in
 * semantics — list the distinct names, cap at three, and when the names are
 * identical ask for something that actually distinguishes them — but in text
 * the operator can scan, with the numbering that makes "the second one" a
 * meaningful answer (`matchDisambiguationFollowUp` parses ordinals first).
 */
export function buildDisambiguationQuestion(pending: PendingEntityAmbiguity): string {
  const label = kindLabel(pending.entityKind);
  const listed = pending.candidates.slice(0, MAX_LISTED_CANDIDATES);
  const distinctNames = new Set(listed.map((c) => c.name.trim().toLowerCase()));

  const quoted = pending.reference ? `"${pending.reference}"` : `that ${label}`;

  if (distinctNames.size < 2) {
    // Same name on every candidate — listing them back is no help at all.
    return (
      `I found ${pending.candidates.length} ${label}s matching ${quoted}, all under the same name. ` +
      `Which one — can you give me the address or phone number?`
    );
  }

  const options = listed
    .map((c, i) => `${i + 1}. ${c.name}${c.hint ? ` (${c.hint})` : ''}`)
    .join('\n');

  return `Which ${label} did you mean by ${quoted}?\n${options}\n\nReply with the number or the name.`;
}
