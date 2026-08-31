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

import { z } from 'zod';
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
  // #909 (live sweeps 9/10) — `update_catalog_item`'s only producer on chat
  // (UpdateCatalogItemTaskHandler, ai/tasks/voice-extended-tasks.ts) writes
  // the spoken/typed item name onto `payload.itemReference` when its own
  // draft-time resolution can't confidently pick a row. `catalogItemReference`
  // is the classifier's own extraction field for the same text (the handler
  // builds `itemReference` FROM it), so in the ordinary case this fallback
  // is a same-string no-op (deduped by `push()` below) — it exists as the
  // same belt-and-braces the other entries carry: if a future producer ever
  // set `missingFields: ['catalogItemId']` without also setting
  // `payload.itemReference`, this is what keeps the gate resolvable instead
  // of silently unfillable.
  catalogItemId: {
    kind: 'catalogItem',
    payloadFields: ['itemReference'],
    entityFields: ['catalogItemReference'],
  },
};

/**
 * Is `key` one of the gated id fields this loop knows how to fill?
 *
 * `Object.hasOwn`, never `GATED_REFERENCE_SOURCES[key] !== undefined`: the
 * table is an object literal, so a plain index lookup answers TRUE for
 * `__proto__`, `constructor` and `toString` — inherited members that are not
 * gated fields at all. Since this predicate guards a payload write driven by
 * persisted JSON, that difference is the difference between a vocabulary
 * check and a write primitive. Caught by the contract test.
 */
export function isGatedReferenceField(key: string): boolean {
  return Object.hasOwn(GATED_REFERENCE_SOURCES, key);
}

/**
 * One gated id field plus the free text the loop will resolve it from.
 *
 * `references` is ORDERED and may hold more than one: the operator often
 * says the same thing two ways in one sentence, and only one of them is a
 * reference the resolver can actually match. "Move qa-matrix-A-customer's
 * tune-up appointment to Friday" yields the compound phrase AND the bare
 * customer name; the compound phrase is the more specific of the two and is
 * tried first, but it scores below the trigram floor against both the job
 * summary and the customer name, so without the second the whole row stalls
 * — measured against real Postgres, not reasoned about.
 *
 * Trying the next reference after a `not_found` is not a second guess: each
 * one is something the operator actually wrote, and an AMBIGUOUS result
 * still stops the ladder and asks.
 */
export interface GatedReferenceLookup {
  idField: string;
  kind: EntityKind;
  references: string[];
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
    if (!isGatedReferenceField(idField)) continue;
    const source = GATED_REFERENCE_SOURCES[idField];
    // Already filled (another lookup in this same pass, or the handler) —
    // nothing to resolve.
    if (trimmed(payload[idField])) continue;

    // Most specific first (what the handler chose), then the classifier's
    // own fields. Deduped so an identical string is never resolved twice.
    const references: string[] = [];
    const seen = new Set<string>();
    const push = (value: unknown): void => {
      const text = trimmed(value);
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      references.push(text);
    };
    for (const field of source.payloadFields) push(payload[field]);
    if (entities) for (const field of source.entityFields) push(entities[field]);
    if (references.length === 0) continue;

    lookups.push({ idField, kind: source.kind, references });
  }

  return lookups;
}

function toPendingAmbiguity(
  lookup: GatedReferenceLookup,
  reference: string,
  candidates: EntityCandidate[],
): PendingEntityAmbiguity {
  return {
    entityKind: lookup.kind,
    reference,
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
    let settled = false;

    // Ladder: try each reference the operator gave, most specific first.
    // A `resolved` or `ambiguous` outcome settles the field; only a
    // not_found / low_confidence / skipped / throw moves on to the next.
    for (const reference of lookup.references) {
      let result;
      try {
        result = await resolver.resolve({
          tenantId,
          reference,
          kind: lookup.kind,
          // A job resolved earlier in THIS pass anchors a later appointment
          // lookup, the same way the FSM's sticky `context.jobId` does
          // (SCH-03). `jobId` is the only anchor the resolver takes today.
          ...(outcome.filled.jobId ? { jobId: outcome.filled.jobId } : {}),
        });
      } catch {
        // This reference is unusable; a sibling may still answer.
        continue;
      }

      if (result.kind === 'resolved') {
        outcome.filled[lookup.idField] = result.candidate.id;
        settled = true;
        break;
      }
      if (result.kind === 'ambiguous') {
        // ONE question per turn. The first ambiguity becomes the question;
        // any later one is left gated and asked on the next pass, once this
        // one is answered.
        if (!outcome.ambiguity) {
          outcome.ambiguity = toPendingAmbiguity(lookup, reference, result.candidates);
        }
        break;
      }
      // `low_confidence` is deliberately NOT auto-adopted. The voice FSM
      // answers that band with a spoken one-tap confirmation turn
      // (`entity_confirm`); on a surface where the operator is already
      // looking at a review card, the honest equivalent is the card they
      // already get — so the gate stays and the candidate is not silently
      // taken. `not_found` / `skipped` fall through to the next reference.
    }

    if (!settled) outcome.unresolved.push(lookup.idField);
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
  // SECURITY (review finding 3) — only a key that is BOTH a known gated id
  // field AND currently gated on this proposal may be written. Without both
  // checks, a `refKey` read back from persisted `sourceContext` JSON could
  // write an arbitrary payload key and an arbitrary `verifiedIds` entry —
  // and `verifiedIds` is precisely the marker that tells `dropUnverifiedIds`
  // a value is DB-verified and must not be scrubbed. In the ordinary
  // post-draft flow this guard is a no-op (`planGatedReferenceLookups` only
  // ever plans gated keys); it exists for the disambiguation-answer path,
  // whose key survives a round trip through the database.
  const gated = new Set(missingFieldsFor(proposal as Proposal));
  const keys = Object.keys(filled).filter(
    (key) => isGatedReferenceField(key) && gated.has(key),
  );
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
    // Only the ACCEPTED keys — spreading `filled` here would reintroduce the
    // arbitrary-key write the guard above exists to stop.
    verifiedIds: {
      ...existingVerified,
      ...Object.fromEntries(keys.map((key) => [key, filled[key]])),
    },
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

/**
 * The persisted shape of a pending question — a RIDE-ALONG CONTRACT, not a
 * convenience type.
 *
 * This blob leaves the process, sits in a JSONB column, and comes back to
 * drive a payload write. Everything downstream of it must therefore be
 * validated, not assumed: a `candidates` element without a `name` used to
 * reach `buildDisambiguationQuestion` and throw on `.trim()` (a 500 on a
 * perfectly ordinary chat turn), and a `refKey` read back unchecked is a
 * write primitive pointed at `payload` and `verifiedIds`.
 *
 * `refKey` is constrained to the gated-id vocabulary here; that it is still
 * GATED on this particular proposal is enforced at the write itself, in
 * `applyGatedReferences` — two different questions, checked in the two
 * different places that can answer them.
 */
const pendingAmbiguitySchema = z.object({
  entityKind: z.enum([
    'customer',
    'job',
    'appointment',
    'invoice',
    'estimate',
    'pending_proposal',
    'technician',
    'lead',
    'catalogItem',
  ]),
  reference: z.string().default(''),
  refKey: z.string().refine(isGatedReferenceField, {
    message: 'refKey must name a known gated id field',
  }),
  candidates: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        // `.trim().min(1)` and not `.min(1)`: a whitespace-only name passes a
        // length check and then reads as nameless everywhere downstream —
        // an option offered to the operator with nothing on it.
        name: z.string().trim().min(1),
        score: z.number().default(0),
        hint: z.string().optional(),
      }),
    )
    .min(1),
  partialRefs: z.record(z.string(), z.string()).default({}),
  attemptCount: z.number().int().min(0).default(0),
});

/**
 * Read back a pending question, if this proposal is carrying a VALID one.
 *
 * Never throws. An invalid blob is treated as no-pending, which the caller
 * turns into "clear it and classify this turn normally" — the same
 * degradation as having no question at all, and the only safe reading of
 * data we cannot trust.
 */
export function pendingAmbiguityOf(
  proposal: Pick<Proposal, 'sourceContext'>,
): PendingEntityAmbiguity | undefined {
  const raw = (proposal.sourceContext as Record<string, unknown> | undefined)?.[
    PENDING_AMBIGUITY_KEY
  ];
  if (!raw || typeof raw !== 'object') return undefined;
  const parsed = pendingAmbiguitySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data as PendingEntityAmbiguity;
}

/**
 * Is this turn plausibly an ANSWER to the pending question?
 *
 * The hijack this closes (review finding 1): recall used to fire on
 * pendency alone, handing every subsequent utterance to a matcher whose
 * seams are deliberately generous for a VOICE turn, where the caller has
 * just been asked a question out loud and their next words are almost
 * certainly the answer. Chat is not that. An operator with a question
 * standing can type anything, and two of the matcher's seams then read an
 * ordinary request as an answer:
 *
 *   - `normalized.includes(label)` (entity-resolution.ts): "Send an invoice
 *     to Johnson Plumbing for $400" CONTAINS a candidate name, so the lead
 *     resolved and the invoice request was discarded, unsent and unlogged.
 *   - `extractStreetNumber`'s `\b(\d{1,5})\b`: "apply a $50 late fee on
 *     invoice 1042" offers "50", which matches any candidate whose address
 *     hint contains 50.
 *   - and in reverse, `label.includes(normalized)`: a bare "ok" is a
 *     substring of "Brooks".
 *
 * So the gate is precision-first and lives HERE rather than in the shared
 * matcher: voice's behavior is unchanged (it is cassette-pinned and its
 * looseness is correct for a spoken turn), and chat simply declines to ask
 * the matcher about turns that do not look like answers. A rejected turn is
 * classified normally and the question is left standing — never consumed,
 * never counted as a failed attempt.
 *
 * Accepts, in order: a bare candidate id; an ordinal ("the second one",
 * "2"); an utterance that IS a candidate's name or is entirely made of
 * words from one ("Dana", "Marcus Johnson"); and a short utterance carrying
 * a number, which is how an address or phone answer arrives ("9 Elm Court",
 * "480-555-0188"). Everything else is a request, not an answer.
 *
 * This gate is allowed to be slightly BROADER than the matcher behind it,
 * and the asymmetry is deliberate. Accepting a turn the matcher then cannot
 * place costs one re-ask. Rejecting a turn the matcher would have placed
 * costs nothing but a manual pick. Accepting a turn that is not an answer
 * at all is the hijack. Only the last is unsafe, so the gate errs toward
 * the first two.
 */
export function isDisambiguationAnswer(
  text: string,
  pending: PendingEntityAmbiguity,
): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?,]+$/g, '').trim();
  if (!normalized) return false;

  if (pending.candidates.some((c) => c.id.toLowerCase() === normalized)) return true;

  if (ORDINAL_ANSWER_RE.test(normalized)) return true;

  // "the residence one" names a candidate exactly as "the second one" names
  // an ordinal — same wrapper, same intent. `parseOrdinalIndex` strips it
  // before matching, so this does too; without it a perfectly natural answer
  // is rejected as a request.
  const compact = normalized.replace(/^the\s+/, '').replace(/\s+one$/, '').trim();

  for (const form of new Set([normalized, compact].filter(Boolean))) {
    const words = form.split(/\s+/).filter(Boolean);
    for (const candidate of pending.candidates) {
      const name = candidate.name.trim().toLowerCase();
      if (!name) continue;
      if (form === name) return true;
      // Every word the operator typed is part of this candidate's name, and
      // they typed few enough of them to be naming it rather than using it
      // in a sentence. "Dana" / "Marcus Johnson" / "the residence one" pass;
      // "Send an invoice to Johnson Plumbing for $400" does not.
      if (words.length <= NAME_ANSWER_MAX_WORDS) {
        const nameTokens = new Set(name.split(/\s+/).filter(Boolean));
        if (words.every((w) => nameTokens.has(w))) return true;
      }
    }
  }

  const words = normalized.split(/\s+/).filter(Boolean);

  // An address or phone answer ("9 Elm Court", "the one on 480-555-0188").
  // Short is doing the work here: a real request that happens to contain a
  // number is longer than this.
  if (words.length <= HINT_ANSWER_MAX_WORDS && /\d/.test(normalized)) return true;

  return false;
}

/**
 * Ordinal answers the follow-up matcher understands. Kept in step with
 * `parseOrdinalIndex` (ai/agents/customer-calling/entity-resolution.ts) — it
 * accepts through third, so nothing beyond third is claimed here.
 */
const ORDINAL_ANSWER_RE =
  /^(the\s+)?(first|second|third|1|2|3|one|two|three|option\s+[123]|primero?|segundo|tercero)(\s+one)?$/;

/** Most words an utterance may have and still be read as NAMING a candidate. */
const NAME_ANSWER_MAX_WORDS = 3;

/** Most words an utterance may have and still be read as an address/phone answer. */
const HINT_ANSWER_MAX_WORDS = 5;

export function clearPendingAmbiguity(proposal: Pick<Proposal, 'sourceContext'>): void {
  const ctx = { ...((proposal.sourceContext ?? {}) as Record<string, unknown>) };
  delete ctx[PENDING_AMBIGUITY_KEY];
  proposal.sourceContext = ctx;
}

/**
 * Human label for a gated entity kind, used in the question copy.
 * Deliberately the operator's word, not the schema's.
 *
 * NOTE (review follow-up): this is one of the five places a new `EntityKind`
 * must be taught about — the others being `REF_KEY_BY_KIND`
 * (ai/agents/customer-calling/entity-resolution.ts), `PgEntityResolver`'s
 * dispatch, `ENTITY_LABEL_QUERIES` + its guard
 * (alias-first-entity-resolver.ts), and `pendingAmbiguitySchema` above. Only
 * this one fails SOFT: the `default` arm degrades to "record", so a missing
 * arm costs a slightly generic question rather than a crash. The other four
 * are compile-time exhaustive or explicitly guarded, which is why they are
 * left as they are rather than collapsed into a registry — a registry would
 * trade four compiler errors for one runtime lookup.
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
    case 'catalogItem':
      return 'catalog item';
    default:
      return 'record';
  }
}

/**
 * Kind-appropriate "here's what would help" phrase for
 * `buildUnresolvedPrompt` below — what a human would actually read off the
 * record to answer with, not the schema's own field name.
 */
function whatToSupply(kind: EntityKind): string {
  switch (kind) {
    case 'invoice':
      return 'the invoice number (e.g. "INV-1005")';
    case 'estimate':
      return 'the estimate number (e.g. "EST-1005")';
    case 'customer':
      return "the customer's name";
    case 'job':
      return 'the job name or number';
    case 'catalogItem':
      return 'the exact catalog item name';
    case 'appointment':
      return 'the date and time';
    case 'technician':
      return "the team member's name";
    case 'lead':
      return "the lead's name (or company)";
    default:
      return 'more detail';
  }
}

/**
 * #909 generalization (2026-08-31) — the honest line for a gated field that
 * resolved to neither a fill nor an ambiguity: `not_found` (nothing
 * matched) and the resolver's own overflow refusal (too many confident
 * matches to safely offer a picker — the MAX_X_CANDIDATES escalation every
 * kind in pg-entity-resolver.ts applies, a deliberate "escalate rather than
 * guess" design, not a bug) both collapse to this SAME outcome shape: no
 * candidates to list, nothing for `buildDisambiguationQuestion` to render.
 *
 * Originally shipped (#946) scoped to `invoiceId` only, after the identical
 * defect reproduced live for send_payment_reminder/apply_late_fee: an
 * unresolved gate silently degraded the chat reply to the SAME "Review and
 * approve to proceed" text a fully-resolved draft gets, so the operator had
 * no signal anything needed their input and D-029's answer turn never got a
 * question to answer. That same silence reproduces for ANY kind whose
 * candidate set can grow past its picker ceiling (estimateId did, live —
 * send_estimate_nudge's fixture customer accumulates 'sent' estimates
 * across sweep runs the same way the invoice fixture accumulates invoices)
 * or that simply matches nothing — so this generalizes the fix to every
 * kind in `GATED_REFERENCE_SOURCES` at once, rather than adding kinds
 * one-by-one as each one's own live failure surfaces.
 *
 * Deliberately NOT a numbered picker — the resolver already refused to
 * fabricate one (that is exactly what `not_found`/overflow means here); a
 * plain-language nudge naming what would let a human resolve it themselves
 * is the honest, safe alternative (never guesses; D-004 untouched).
 */
export function buildUnresolvedPrompt(kind: EntityKind): string {
  return `I couldn't automatically match that — reply with ${whatToSupply(kind)} and I'll pick it up.`;
}

/**
 * The ONE thing the chat surface says back after a post-draft resolution
 * pass, given its outcome. Pure — no I/O, no proposal mutation (the caller
 * already applied `outcome.filled`/stamped the ambiguity before calling
 * this) — so the full "what does the operator see" decision for EVERY
 * registered kind is unit-testable without a resolver, a proposal, or an
 * HTTP route. Extracted from routes/assistant.ts's `resolveGatedReferencesForChat`
 * (2026-08-31) specifically so a table-driven test could cover every kind
 * in `GATED_REFERENCE_SOURCES` at once (D-026's "one core, thin adapters" —
 * this IS the core; the chat route is the thin adapter that applies the
 * outcome and calls this for the copy).
 *
 * Three outcomes, in priority order:
 *   ambiguous, and this caller is asking → the ONE numbered question
 *     (`buildDisambiguationQuestion`).
 *   otherwise, something is still unresolved → the honest can't-match line
 *     for the FIRST such field (`buildUnresolvedPrompt`) — covers BOTH
 *     `not_found` (nothing matched) and the resolver's own overflow refusal
 *     (too many confident matches to safely offer a picker): both collapse
 *     to the identical `unresolved`-with-no-`ambiguity` shape at this
 *     layer, so there is nothing that distinguishes them for this function
 *     to special-case — the honest line covers both by construction.
 *   nothing left unresolved (fully resolved, or this caller isn't asking —
 *     the chain path passes `askClarification: false`) → undefined, the
 *     caller's existing reply stands unchanged.
 */
export function buildGatedReferenceReply(
  outcome: GatedReferenceOutcome,
  askClarification: boolean,
): string | undefined {
  if (!askClarification) return undefined;
  if (outcome.ambiguity) return buildDisambiguationQuestion(outcome.ambiguity);
  if (outcome.unresolved.length > 0) {
    const source = GATED_REFERENCE_SOURCES[outcome.unresolved[0]];
    if (source) return buildUnresolvedPrompt(source.kind);
  }
  return undefined;
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
    // Same name on every candidate. "Address or phone number" is a real
    // follow-up ONLY for a person/company kind (customer, lead) — it is
    // meaningless for a catalog item, a job, an invoice. #909 (live sweeps
    // 9/10) — the AI-catalog sweep's own fixture reproduces this exactly:
    // `add_catalog_item` mints a fresh, identically-named catalog row every
    // run with nothing to quarantine the prior runs' copies, so
    // `update_catalog_item` routinely lands here for a kind that was never
    // going to have an address or phone. When every candidate instead
    // carries its own DISTINCT hint (a catalog item's price, an invoice's
    // status), that hint is the thing that actually tells them apart —
    // list it instead of asking for a detail this kind cannot answer.
    const distinctHints = new Set(listed.map((c) => (c.hint ?? '').trim().toLowerCase()));
    if (distinctHints.size >= 2 && !distinctHints.has('')) {
      const hinted = listed.map((c, i) => `${i + 1}. ${c.name} (${c.hint})`).join('\n');
      return (
        `I found ${pending.candidates.length} ${label}s matching ${quoted}, all under the same name. ` +
        `Which one?\n${hinted}\n\nReply with the number.`
      );
    }
    // Nothing else distinguishes them either — listing them back is no
    // help at all.
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
