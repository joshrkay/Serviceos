/**
 * D-045 point 8 — drafting has one entry point and three outcomes.
 *
 * Every surface that turns an operator's words into a proposal drafts through
 * `draftProposal`: the task handler drafts, then the same checks run whatever
 * the surface — the surface's repo-verified ids are recorded and filled in,
 * any id the operator never said and no lookup verified is scrubbed, and the
 * payload's own contract gates the card. The result is a *draft outcome*: a
 * proposal, a clarification (a gated draft that needs an answer before it
 * can be approved), or a refusal with a reason. The surface only decides how
 * to say it.
 */
import { Proposal, missingFieldsFor } from '../../proposals/proposal';
import { validateProposalPayload } from '../../proposals/contracts';
import { clearSatisfiedMissingFields } from '../../proposals/missing-fields';
import { isGatedReferenceField } from '../resolution/gated-reference-resolution';
import {
  withClassifierRun,
  type TaskContext,
  type TaskHandler,
  type TaskResult,
} from '../tasks/task-handlers';

export type DraftOutcome =
  | { kind: 'proposal'; proposal: Proposal }
  /** Drafted but gated: the card can't be approved until these are answered. */
  | { kind: 'clarification'; proposal: Proposal; missingFields: string[] }
  /**
   * Nothing to put in front of the operator. `not_drafted`: the handler
   * produced no proposal. `nothing_left`: the surface's own rule removed
   * everything the draft would have done.
   */
  | { kind: 'refusal'; code: 'not_drafted' | 'nothing_left'; reason: string };

export const NOT_DRAFTED_REASON = "I couldn't turn that into something to approve.";

export interface DraftRequest {
  handler: TaskHandler;
  context: TaskContext;
  /** The operator's own words for this draft: an id in the payload must appear here… */
  operatorText: string;
  /** …or in the classifier's entities… */
  entities: Record<string, unknown>;
  /**
   * …or here: ids the surface resolved by a repo lookup. SECURITY: never
   * classifier or model output (see `dropUnverifiedIds`).
   */
  verifiedIds?: Record<string, string>;
  /** OBS-2 — the classifier run that routed this draft. */
  classifierAiRunId?: string;
  /**
   * A surface rule run after the id scrub and before the contract gate.
   * Returning a reason refuses the draft (`nothing_left`).
   */
  beforeGate?: (proposal: Proposal) => string | undefined;
  /**
   * Where a draft that was approved but turns out to need an answer goes.
   * Chat keeps it a `draft`. Voice memos pass `ready_for_review`, the status
   * every other memo hold uses, so the owner is still told about the card.
   */
  heldStatus?: 'draft' | 'ready_for_review';
}

export async function draftProposal(request: DraftRequest): Promise<DraftOutcome> {
  // A handler can come back empty (a test double, a defensive early exit).
  const { proposal: drafted }: Partial<TaskResult> = await request.handler.handle(request.context);
  if (!drafted) return { kind: 'refusal', code: 'not_drafted', reason: NOT_DRAFTED_REASON };
  return finishDraft(withClassifierRun(drafted, request.classifierAiRunId), request);
}

/** The checks every draft gets, in order. Mutates and returns the outcome. */
function finishDraft(
  proposal: Proposal,
  request: Pick<DraftRequest, 'operatorText' | 'entities' | 'verifiedIds' | 'beforeGate' | 'heldStatus'>,
): DraftOutcome {
  const verifiedIds = request.verifiedIds ?? {};
  stampVerifiedIds(proposal, verifiedIds);
  // Scrub before filling: a made-up id would otherwise hold the slot a
  // verified id should take (the fill never overwrites).
  dropUnverifiedIds(proposal.payload, request.operatorText, request.entities, proposal.sourceContext);
  applyVerifiedIdsToPayload(proposal, verifiedIds);
  const refused = request.beforeGate?.(proposal);
  if (refused) return { kind: 'refusal', code: 'nothing_left', reason: refused };
  const heldStatus = request.heldStatus ?? 'draft';
  applyContractGate(proposal, heldStatus);
  const missingFields = missingFieldsFor(proposal);
  const clarification = (proposal.payload as { clarification?: { needed?: unknown } }).clarification;
  if (missingFields.length > 0 || clarification?.needed === true) {
    // A question is never already approved, whichever check raised it.
    if (proposal.status === 'approved') {
      proposal.status = heldStatus;
      proposal.approvedAt = undefined;
    }
    return { kind: 'clarification', proposal, missingFields };
  }
  return { kind: 'proposal', proposal };
}

/**
 * `updateCustomerPayloadSchema`'s "changed nothing" set and
 * `updateJobPayloadSchema`'s "at least one field to change" set — the two
 * whole-object conditions `contractGateMissingFields` below can name.
 * Mirrors `proposals/voice-payload.ts`'s private `UPDATE_CUSTOMER_FIELD_ALIASES`
 * / `JOB_EDIT_FIELDS`.
 */
export const JOB_EDIT_FIELDS = ['status', 'priority', 'title', 'description'] as const;
const UPDATE_CUSTOMER_FIELDS = ['name', 'email', 'phone', 'address'] as const;

/**
 * Whole-object contract refines, named as a payload key an operator can fill.
 *
 * Zod reports a `.refine()` on the whole object with `path: []`, so the error
 * string carries NOTHING to gate on. A caller that persists such a payload
 * ungated has minted an approve-to-fail card: the review screen offers
 * Approve, the execution handler then throws, and the operator is told the
 * work is done when nothing was written.
 *
 * KNOWN DUPLICATION — this is the chat twin of `namedContractGap` in
 * `proposals/voice-payload.ts` (which is private to that module). The two
 * MUST agree: a booking drafted by voice and the same booking typed into chat
 * have to gate on the same field or the two surfaces drift on what is
 * approvable. Hoist both into one shared module the moment
 * `voice-payload.ts` is free to change.
 */
function namedDraftContractGap(
  proposalType: string,
  payload: Record<string, unknown>,
): string[] {
  switch (proposalType) {
    // `createAppointmentPayloadSchema`'s SCH-02 refine: "requires jobId (or
    // linkedJobId), or a customerId the executor can open a job for".
    case 'create_appointment':
      return !payload.jobId && !payload.linkedJobId && !payload.customerId ? ['customerId'] : [];
    case 'update_job':
      return JOB_EDIT_FIELDS.some((f) => payload[f] !== undefined) ? [] : ['status'];
    case 'send_estimate_nudge':
      return !payload.estimateId && !payload.estimateReference ? ['estimateId'] : [];
    // NOT a refine: `updateCustomerPayloadSchema` needs only `customerId`, so
    // an edit that changes nothing is contract-VALID and then executes as a
    // silent no-op. `updatedField` is a sentinel, not a payload key — see the
    // voice twin's note on why it is deliberately unliftable by an edit.
    case 'update_customer':
      return UPDATE_CUSTOMER_FIELDS.some((f) => payload[f] !== undefined) ||
        (typeof payload.notes === 'string' && payload.notes.trim().length > 0)
        ? []
        : ['updatedField'];
    default:
      return [];
  }
}

/**
 * THE CHAT CHOKEPOINT'S CONTRACT GATE — the twin of what
 * `buildVoiceProposalPayload` does for every voice-originated proposal
 * ("§5 The contract gate", proposals/voice-payload.ts).
 *
 * Voice validates the payload it just built and, when it fails, hands the
 * caller `missingFieldPaths` so the draft is persisted GATED. Chat had no
 * equivalent: whatever the drafting handler returned was persisted verbatim,
 * so every chat-drafted proposal whose payload failed its own contract
 * WITHOUT the handler happening to gate it was an approve-to-fail card. The
 * in-app 50-case register found four families of it at once —
 * `create_appointment` (no customerId/jobId — the model cannot invent a uuid
 * and nothing else threaded one), `update_estimate` / `update_invoice`
 * (`editActions` empty) and `update_job` ("at least one field to change") —
 * i.e. every booking and every edit typed into the assistant.
 *
 * Returns the field names to gate on: the first path segment of each Zod
 * error (the flat key an operator edits, which is what
 * `clearSatisfiedMissingFields` matches on) plus the named whole-object gaps
 * above. An empty result means the payload is approvable as drafted.
 */
export function contractGateMissingFields(
  proposalType: string,
  payload: Record<string, unknown>,
  /**
   * True when the draft is ALREADY gated on a reference id
   * (`isGatedReferenceField`) that the operator will answer through the
   * which-one / gated-reference loop. Every other contract error is then
   * downstream of that reference — `update_catalog_item`'s
   * `currentUnitPriceCents` is copied from the catalog row the moment
   * `catalogItemId` resolves (UpdateCatalogItemTaskHandler), and gating it now
   * would leave a card the loop can never clear. Only the NAMED gaps apply
   * while a reference is pending; the contract-derived pass runs once the
   * reference question is settled. Pinned by the #909 integration test
   * `chat-entity-resolution` (duplicate-named catalog → `['catalogItemId']`).
   */
  pendingReference = false,
): string[] {
  const gaps = new Set<string>(namedDraftContractGap(proposalType, payload));
  if (pendingReference) return [...gaps];
  const result = validateProposalPayload(proposalType, payload);
  for (const error of result.valid ? [] : result.errors ?? []) {
    const path = error.slice(0, error.indexOf(':'));
    if (!path) continue;
    const head = path.split('.')[0]?.replace(/\[\d+\]$/, '');
    if (head) gaps.add(head);
  }
  return [...gaps];
}


/**
 * Apply the gate to a freshly drafted proposal, in place.
 *
 * Two effects, both load-bearing:
 *   1. the named fields are merged into `sourceContext.missingFields`, which
 *      is what blocks Approve AND what the post-draft gated-reference loop
 *      (`resolveGatedReferencesForChat`) reads to know which references to go
 *      and resolve — so gating a booking on `customerId` is also what lets
 *      the resolver fill it from the customer name in the same turn;
 *   2. a proposal that had already been decided `approved` is pulled back to
 *      `draft` (or the surface's `heldStatus`). An auto-approving type whose payload cannot execute must
 *      never reach the worker; the operator's tap is the only thing that
 *      should move it, and only once the gate is closed.
 *
 * Returns the fields it added (empty when the payload was already fine).
 */
export function applyContractGate(
  proposal: Proposal,
  heldStatus: 'draft' | 'ready_for_review' = 'draft',
): string[] {
  const existing = new Set(missingFieldsFor(proposal));
  const pendingReference = [...existing].some((field) => isGatedReferenceField(field));
  const gaps = contractGateMissingFields(proposal.proposalType, proposal.payload, pendingReference);
  if (gaps.length === 0) return [];
  const added = gaps.filter((field) => !existing.has(field));
  if (added.length === 0) return [];
  proposal.sourceContext = {
    ...(proposal.sourceContext ?? {}),
    missingFields: [...existing, ...added],
  };
  if (proposal.status === 'approved') {
    proposal.status = heldStatus;
    // A later tap keeps an existing approvedAt, so a stale one would start
    // the undo window at drafting time instead of at the tap.
    proposal.approvedAt = undefined;
  }
  return added;
}

/**
 * QA-2026-06-05: the assistant accepts FREE TEXT — entity ids in LLM-built
 * payloads must literally appear in the operator's message (or classifier
 * entities); the model may not invent them (live: hallucinated textbook
 * UUIDs sent executions into doomed lookups).
 *
 * B4 — extended with a `sourceContext.verifiedIds` allowlist: an id a task
 * handler resolved via a REPO LOOKUP (not LLM text) — e.g.
 * IssueInvoiceTaskHandler's conversation-context resolution of "the one we
 * just drafted" — is verifiable by construction even though it never
 * literally appears in the operator's words. `verifiedIds` must be stamped
 * ONLY by such repo-lookup code paths (see the doc comment on
 * IssueInvoiceTaskHandler in ai/orchestration/task-router.ts); this function
 * trusts whatever is there, so a handler that ever copied LLM/classifier
 * output into `verifiedIds` would reopen the exact hallucinated-id hole this
 * scrub exists to close. A key present in `payload` but ABSENT from
 * `verifiedIds` (or not exactly matching the verified value) still gets the
 * ordinary haystack check — a hallucinated id is stripped regardless of
 * whether some other key happened to get verified.
 */
// Exported for a direct unit pin on the verifiedIds allowlist semantics
// (test/routes/assistant.route.test.ts) — this is B4's main review surface.
export function dropUnverifiedIds(
  payload: Record<string, unknown>,
  operatorText: string,
  entities: Record<string, unknown>,
  sourceContext?: Record<string, unknown>
): void {
  const haystack = (operatorText + ' ' + JSON.stringify(entities)).toLowerCase();
  const verifiedIds =
    sourceContext?.verifiedIds && typeof sourceContext.verifiedIds === 'object'
      ? (sourceContext.verifiedIds as Record<string, unknown>)
      : undefined;
  // technicianId is not here: handlers look technicians up themselves
  // without stamping verifiedIds (voice-extended-tasks.ts).
  for (const key of ['jobId', 'linkedJobId', 'customerId', 'estimateId', 'invoiceId', 'appointmentId']) {
    const v = payload[key];
    if (typeof v !== 'string' || v.length < 32) continue;
    if (haystack.includes(v.toLowerCase())) continue;
    if (verifiedIds && verifiedIds[key] === v) continue;
    delete payload[key];
  }
}

/**
 * U1 — record route-resolved ids on `sourceContext.verifiedIds` so
 * `dropUnverifiedIds` preserves them (pattern: IssueInvoiceTaskHandler's
 * rung-2 conversation-context resolution, ai/orchestration/task-router.ts).
 * SECURITY: callers must only pass ids from a DB lookup — chat's
 * `resolveVerifiedIdsForDraft`; on memos the resolver's matches, the caller-ID
 * customer and the job the memo was recorded on — never classifier/LLM output. A task handler's own
 * repo-verified `verifiedIds` (e.g. send_estimate_nudge's liftGate) win on
 * key collision; both sources are DB-verified so either value is safe.
 */
export function stampVerifiedIds(
  proposal: { sourceContext?: Record<string, unknown> },
  verifiedIds: Record<string, string>,
): void {
  if (Object.keys(verifiedIds).length === 0) return;
  const existing =
    proposal.sourceContext?.verifiedIds && typeof proposal.sourceContext.verifiedIds === 'object'
      ? (proposal.sourceContext.verifiedIds as Record<string, unknown>)
      : {};
  proposal.sourceContext = {
    ...(proposal.sourceContext ?? {}),
    verifiedIds: { ...verifiedIds, ...existing },
  };
}

/**
 * Put the PIPELINE's own resolved ids where the executor looks for them.
 *
 * `resolveVerifiedIdsForDraft` already resolved the operator's free-text
 * references to real tenant ids before drafting, and `existingEntities` carried
 * them into the task handler — but a handler only copies an id onto the payload
 * if its own drafting model happened to echo it back. `create-appointment-task.ts`
 * says exactly why that is not resolution: "A drafting leg that depends on a
 * model repeating a UUID is not resolution." Live evidence agreed — the model
 * echoed a job TITLE into `jobId` — and the in-app 50-case register showed the
 * quieter half of the same defect: "Book Garcia for Tuesday at 2 pm" drafted an
 * appointment with NO customerId at all, "Prepare an estimate for Johnson's
 * water heater job" drafted an estimate attached to no job, and "Hand Garcia's
 * Tuesday visit to Carlos" drafted a reassignment naming no technician.
 *
 * So the route writes them itself. Safety, in order:
 *   - only the gated-id vocabulary (`isGatedReferenceField`) — the same keys
 *     the post-draft resolution loop is allowed to fill, never an arbitrary key;
 *   - only ids from `resolveVerifiedIdsForDraft`, which are repo lookups by
 *     construction — never classifier or model output (the `dropUnverifiedIds`
 *     security rule);
 *   - never OVERWRITE a value the handler already resolved for itself;
 *   - and reverted if writing it would make a previously valid payload invalid,
 *     so this can only ever move a proposal toward approvable.
 *
 * Returns the keys it wrote.
 */
export function applyVerifiedIdsToPayload(
  proposal: Pick<Proposal, 'proposalType' | 'payload' | 'sourceContext'>,
  verifiedIds: Record<string, string>,
): string[] {
  const wasValid = validateProposalPayload(proposal.proposalType, proposal.payload).valid;
  const written: string[] = [];
  const replaced: Record<string, unknown> = {};
  for (const [key, id] of Object.entries(verifiedIds)) {
    if (!isGatedReferenceField(key)) continue;
    const current = proposal.payload[key];
    // A value that is not an id at all (a job title echoed into jobId, a
    // padded uuid) would otherwise hold the slot and leave the card gated
    // on a field nothing can fill.
    if (typeof current === 'string' && current.trim().length > 0 && isWellFormedId(current)) continue;
    if (current !== undefined) replaced[key] = current;
    proposal.payload[key] = id;
    written.push(key);
  }
  if (
    written.length > 0 &&
    wasValid &&
    !validateProposalPayload(proposal.proposalType, proposal.payload).valid
  ) {
    for (const key of written) {
      if (key in replaced) proposal.payload[key] = replaced[key];
      else delete proposal.payload[key];
    }
    return [];
  }
  // Clear-on-fill, through the SAME shared helper `applyGatedReferences` uses.
  // Writing the id without lifting the gate would be strictly worse than doing
  // nothing: the card would carry a resolved appointmentId AND still refuse to
  // approve, and the resolution loop skips a field that is already filled, so
  // nothing downstream would ever lift it.
  if (written.length > 0) {
    const missing = missingFieldsFor(proposal as Proposal);
    if (missing.length > 0) {
      proposal.sourceContext = {
        ...(proposal.sourceContext ?? {}),
        missingFields: clearSatisfiedMissingFields(missing, written, proposal.payload),
      };
    }
  }
  return written;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A uuid, or a chain reference to an earlier step's id. */
function isWellFormedId(value: string): boolean {
  return UUID_SHAPE.test(value) || value.startsWith('$ref:');
}
