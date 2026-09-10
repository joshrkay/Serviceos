/**
 * Voice → proposal PAYLOAD CONTRACT (the single flat-payload builder).
 *
 * Every execution handler in `proposals/execution/*` reads FLAT payload keys
 * (`payload.customerId`, `payload.jobId`, `payload.scheduledStart`,
 * `payload.appointmentId`, `payload.name`, …) and every per-type schema in
 * `proposals/contracts.ts` encodes that same flat shape. The voice surfaces,
 * however, receive an FSM side effect whose payload is a NESTED envelope
 * (`{ intent, entities, sessionId, callSid }` — see
 * `ai/agents/customer-calling/transitions.ts transitionIntentConfirm`).
 *
 * Two different translations of that envelope grew independently:
 *   - `ai/agents/customer-calling/inapp-adapter.ts handleCreateProposal`
 *     promotes entities to the top level (the known-correct implementation,
 *     hardened by a run of live QA failures — see its QA-2026-* comments);
 *   - `ai/voice-turn/create-voice-turn-processor.ts handleCreateProposal`
 *     (the REAL Twilio phone path) did not, so every inbound-caller proposal
 *     was born unexecutable.
 *
 * This module is that translation, owned in ONE place next to the contract it
 * has to satisfy. It is deliberately narrow:
 *
 *   OWNS      reserved-envelope discipline, scalar promotion, the classifier→
 *             contract key aliases, the caller-identity customerId bridge,
 *             line-item assembly/grounding + `_meta`, and the final
 *             `validateProposalPayload` gate.
 *   DOES NOT  entity resolution (the CALLER resolves first and passes
 *   OWN       POST-resolution entities), surface gating / S1 coercion,
 *             session/FSM/TwiML/transport, persistence, `buildProposal`,
 *             status decisions, `sourceContext`, or the clarification payload
 *             shape.
 *
 * Dependency note: `proposals/` must not import `ai/resolution/*` (the catalog
 * resolver imports back through the proposal contracts). Line-item grounding
 * is therefore INJECTED as `deps.groundLineItems` rather than imported, and the
 * grounding result is described structurally by `VoiceLineItemGrounding` below
 * so no `ai/` type has to be named here.
 */
import type { ProposalType } from './proposal';
import { validateProposalPayload, type ProposalConfidenceMeta } from './contracts';
import { parseJobEditFields } from './job-edit-phrases';

/**
 * Structural view of `ai/resolution/catalog-resolver.ts`'s
 * `CatalogPricingOutcome` as re-shaped by the voice grounding helpers
 * (`create-voice-turn-processor.ts groundVoiceQuote` /
 * `inapp-adapter.ts buildVoiceDraftLineItems`). Declared structurally so this
 * module does not import `ai/` — anything with these fields satisfies it.
 */
export interface VoiceLineItemGrounding {
  /** Grounded, priced line items in the shape `lineItemSchema` accepts. */
  lineItems: Array<Record<string, unknown>>;
  /** RV-007 confidence marker fragment to stamp on the payload. */
  meta?: ProposalConfidenceMeta;
  /** Fields the operator must complete (drives `buildProposal.missingFields`). */
  missingFields?: string[];
  /** Uncatalogued-capped classifier confidence, when the grounder computed one. */
  confidenceScore?: number;
}

/**
 * Injected catalog grounding. Called ONLY for the line-item proposal types
 * below, and only when the classifier emitted at least one non-empty
 * description. Returning `undefined` means "no line items to attach" — the
 * payload is then built without `lineItems` (and the contract gate decides
 * whether that is fatal for this proposal type).
 */
export type GroundLineItemsFn = (
  descriptions: string[],
) => Promise<VoiceLineItemGrounding | undefined>;

/** Proposal types whose contract requires a priced `lineItems` array. */
const GROUNDED_LINE_ITEM_PROPOSAL_TYPES: ReadonlySet<ProposalType> = new Set<ProposalType>([
  'draft_estimate',
  'draft_invoice',
]);

/**
 * Envelope keys the promotion loop must never clobber. `intent`, `entities`,
 * `sessionId`, `conversationId` and `callSid` are the envelope itself;
 * `confidence` is proposal metadata, not payload; `customerId` is set
 * explicitly below (see `resolveCustomerId`) rather than by the generic loop,
 * so a future edit to this set can't silently change which customer id wins.
 */
const RESERVED_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'intent',
  'entities',
  'sessionId',
  'conversationId',
  'callSid',
  'customerId',
  'confidence',
]);

export interface BuildVoiceProposalPayloadInput {
  /** Classifier intent string (`undefined` when the turn had no intent). */
  intent: string | undefined;
  /** The type the caller decided on, AFTER any surface gating / S1 coercion. */
  proposalType: ProposalType;
  /**
   * POST-resolution entities: free-text references already resolved to ids and
   * spoken times already parsed to ISO instants (`entity-resolution.ts`
   * `resolveSchedulingEntities`, folded into the FSM's `extractedEntities`).
   * This module never resolves — it only re-keys what it is given.
   */
  entities: Record<string, unknown>;
  envelope: { sessionId: string; callSid?: string; conversationId?: string };
  /**
   * Classifier confidence. Used only as the fallback for the returned
   * `confidence` when grounding produced no (uncatalogued-capped) score.
   */
  confidence?: number;
  /**
   * The IDENTIFIED caller's customer id — session identity (caller-ID match /
   * self-signup), NEVER transcript content. Used as the fallback when entity
   * resolution produced no more specific customer.
   */
  callerCustomerId?: string;
  /**
   * The operator's OWN WORDS for the turn this proposal came from
   * (`intent_classified.utterance`, parked on the FSM context as
   * `lastUtterance` and threaded back through the `create_proposal` side
   * effect). Read ONLY by the deterministic `update_job` field parse below:
   * `update_job`'s classifier entity set is `jobReference` alone, so the
   * STATUS the operator asked for exists nowhere but the transcript. Never
   * used as an entity reference and never used to invent an id.
   */
  utterance?: string;
}

export interface BuildVoiceProposalPayloadDeps {
  tenantId: string;
  groundLineItems?: GroundLineItemsFn;
}

/**
 * The built payload always comes back, `ok` reports whether it satisfies its
 * type's contract, and `errors` / `missingFieldPaths` describe what it failed.
 *
 * (The originally-proposed shape returned NOTHING on failure. That forces the
 * caller to throw the caller's request away, but this codebase already has a
 * better answer for "the AI produced a partial payload": persist the draft with
 * `missingFields`, which `approveProposal` refuses to approve until an operator
 * fills them — see proposals/actions.ts. Handing the payload back lets the
 * caller choose between that and a clarification, per proposal type.)
 */
export type BuildVoiceProposalPayloadResult = {
  payload: Record<string, unknown>;
  confidence?: number;
  lineItemOutcome?: VoiceLineItemGrounding;
  /**
   * Top-level payload keys an operator must fill before this proposal can be
   * approved, deduped — the exact flat keys `clearSatisfiedMissingFields`
   * (proposals/actions.ts) lifts when an operator edits them, so they are safe
   * to use as a `missingFields` approval gate.
   *
   * ALWAYS PRESENT, and deliberately INDEPENDENT of `ok`. Most entries come
   * from a contract failure, but a payload can be perfectly contract-VALID and
   * still be unapprovable: `updateCustomerPayloadSchema` requires only
   * `customerId`, so "update Khan's ..." with no new value validates and then
   * executes as a silent no-op (register case cust-02). `ok` answers "does
   * Zod accept this"; this answers "can a human approve it as it stands".
   *
   * EMPTY on an `ok: false` result means every failure was a whole-object
   * refine with no field path AND no `namedContractGap` entry recognised it:
   * nothing nameable for an operator to fill, so the caller should degrade
   * rather than gate.
   */
  missingFieldPaths: string[];
} & (
  | { ok: true }
  | {
      ok: false;
      /** `path: message`, straight from `validateProposalPayload`. */
      errors: string[];
    }
);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Which customer id the payload carries.
 *
 * `entities.customerId` is the RESOLVED CRM customer (entity resolution folds
 * a resolver-validated id into `extractedEntities`; `transitionIntentConfirm`
 * also seeds it from the caller's sticky session identity). It wins. The
 * explicit `callerCustomerId` is the fallback for surfaces that keep session
 * identity outside `entities`. Never invented, never taken from free text.
 */
function resolveCustomerId(
  entities: Record<string, unknown>,
  callerCustomerId: string | undefined,
): string | undefined {
  return nonEmptyString(entities.customerId) ?? nonEmptyString(callerCustomerId);
}

/**
 * classifier key → `updateCustomerPayloadSchema` / `UpdateCustomerTaskHandler`
 * field. Ordered exactly as the task handler assigns them so the two legs
 * cannot drift.
 */
const UPDATE_CUSTOMER_FIELD_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['updatedName', 'name'],
  ['updatedEmail', 'email'],
  ['updatedPhone', 'phone'],
  ['updatedAddress', 'address'],
];

/** `updateJobPayloadSchema`'s "at least one field to change" set. */
const JOB_EDIT_FIELDS = ['status', 'priority', 'title', 'description'] as const;

function hasAnyJobEditField(flat: Record<string, unknown>): boolean {
  return JOB_EDIT_FIELDS.some((field) => flat[field] !== undefined);
}

/**
 * `SendPaymentReminderExecutionHandler`'s `MANUAL_REMINDER_PAYLOAD_STEP_KEY`
 * (proposals/execution/send-payment-reminder-handler.ts). Duplicated as a
 * literal rather than imported for the same reason contracts.ts duplicates the
 * chain-ref token regex: the payload-contract layer must not depend on an
 * execution handler. Cross-referenced so the two can't drift silently.
 */
const MANUAL_REMINDER_STEP_KEY = 'manual';

/**
 * Whole-object contract refines this builder can detect BEFORE Zod runs, and
 * the single flat payload key each one is gated on.
 *
 * These exist because `fieldPathsFrom` (below) keeps only the first path
 * SEGMENT of a Zod error, and a `.refine()` on the whole object reports
 * `path: []` — nothing nameable. A caller handed `ok: false` with an EMPTY
 * `missingFieldPaths` has no field to gate on, so it either persists an
 * ungated invalid payload (approve-to-fail) or throws the operator's request
 * away. Every entry here is a condition the payload can be checked for
 * directly, so the draft can be persisted GATED instead.
 *
 * Each returned key should be a real flat payload key an operator can fill:
 * `clearSatisfiedMissingFields` (proposals/missing-fields.ts) lifts a gate
 * only when that exact key is edited to a non-empty value. The one deliberate
 * exception is `update_customer`'s `updatedField` sentinel — see its case.
 */
function namedContractGap(
  proposalType: ProposalType,
  flat: Record<string, unknown>,
): string[] {
  switch (proposalType) {
    // D01 (2026-08-30) — `createAppointmentPayloadSchema`'s SCH-02 refine
    // ("requires jobId (or linkedJobId), or a customerId the executor can
    // open a job for"). A new-caller booking ("Jordan Lee, 480-555-0199...")
    // with no resolvable jobId/customerId had NOTHING nameable to gate on:
    // the payload either persisted unchanged with no missingFields (S2,
    // in-app — see inapp-adapter.ts) or degraded to a bare
    // voice_clarification (S1, telephony), and a scripted/auto approval could
    // reach `CreateAppointmentExecutionHandler` and fail there instead
    // ("Payload must include a valid jobId" — live evidence, sweep row D01).
    case 'create_appointment':
      return !flat.jobId && !flat.linkedJobId && !flat.customerId ? ['customerId'] : [];
    // `updateJobPayloadSchema`'s "at least one field to change" refine, after
    // the deterministic phrase parse above has had its turn. `status` is the
    // named gate because it is the field the overwhelming majority of spoken
    // job edits mean and the one the review card offers first — the operator
    // picking any of the four lifts the gate the same way.
    case 'update_job':
      return hasAnyJobEditField(flat) ? [] : ['status'];
    // `sendEstimateNudgePayloadSchema`'s "estimateId or estimateReference"
    // refine. "Nudge Khan about the pending estimate" names only the
    // customer, so when the customer-anchored estimate lookup
    // (ai/agents/customer-calling/entity-resolution.ts
    // `planCustomerAnchoredDocumentLookup`) finds nothing to attach, this is
    // what keeps the card gated rather than ungated-and-invalid (register
    // case est-06).
    case 'send_estimate_nudge':
      return !flat.estimateId && !flat.estimateReference ? ['estimateId'] : [];
    // `sendInvoicePayloadSchema`'s "invoiceId or invoiceReference" refine —
    // the same shape as `send_estimate_nudge` above, and it had no entry here.
    //
    // The gate is on `invoiceId`, not on the refine: `SendInvoiceExecutionHandler`
    // (proposals/execution/voice-extended-handlers.ts) requires
    // `payload.invoiceId` to ALREADY be a uuid and never reads
    // `invoiceReference` at all, so a payload carrying only the spoken name is
    // contract-valid and still cannot execute. `SendInvoiceTaskHandler` has
    // always gated exactly this way on the memo/chat leg (`missing.push
    // ('invoiceId')` whenever the reference is not a resolved id); the
    // live-turn leg had no equivalent, which is the drift this module exists
    // to prevent. The gate is liftable: `GATED_REFERENCE_SOURCES.invoiceId`
    // resolves it from `invoiceReference` (#909 — never a gate with nothing
    // behind it).
    case 'send_invoice':
      return flat.invoiceId ? [] : ['invoiceId'];
    // NOT a refine — `updateCustomerPayloadSchema` requires only
    // `customerId`, so an edit that changes NOTHING is contract-VALID and
    // then executes as a silent no-op ("I updated Khan's email" and nothing
    // moved — register case cust-02). `UpdateCustomerTaskHandler`
    // (ai/tasks/voice-extended-tasks.ts) has always gated this on the memo
    // leg with exactly this field name; the live-turn leg had no equivalent,
    // which is the whole drift this module exists to prevent.
    //
    // `updatedField` is a SENTINEL, not a payload key, so
    // `clearSatisfiedMissingFields` can never lift it by an edit — the card
    // stays unapprovable until the operator re-states the request. That is
    // deliberate and is the honest outcome: this branch is reached only when
    // NOTHING was heard about what to change, so there is no field to name
    // and nothing to apply. (Naming one of the four concretely would gate on
    // a guess at which one the operator meant.) Byte-identical to the memo
    // leg's gate, so a re-draft of the same request behaves the same way on
    // both.
    case 'update_customer':
      return UPDATE_CUSTOMER_FIELD_ALIASES.some(([, target]) => flat[target] !== undefined) ||
        nonEmptyString(flat.notes)
        ? []
        : ['updatedField'];
    default:
      return [];
  }
}

/**
 * Build the FLAT, contract-valid payload for a voice-originated proposal.
 *
 * Never throws on payload content: a payload that fails its type contract
 * comes back as `{ ok: false, errors }` so a live-call caller is handed a
 * clarification instead of an exception. (A programming error — e.g. an
 * unknown proposal type — still surfaces through `errors`.)
 */
export async function buildVoiceProposalPayload(
  input: BuildVoiceProposalPayloadInput,
  deps: BuildVoiceProposalPayloadDeps,
): Promise<BuildVoiceProposalPayloadResult> {
  const { intent, proposalType, entities, envelope } = input;

  // ── 1. Generic scalar promotion ───────────────────────────────────────────
  // For MOST entities the classifier's key IS the task-contract field name.
  // Only scalars are lifted; arrays/objects need explicit handling (line items
  // below) so we never promote a shape a contract can't read.
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entities)) {
    if (RESERVED_ENVELOPE_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      flat[key] = value;
    }
  }

  // ── 2. Aliases where the two vocabularies DIVERGE ─────────────────────────
  // Each mirrors a translation a non-voice path already performs; the generic
  // loop copies keys verbatim and cannot express these.

  // create_customer: classifier emits `displayName`, the contract wants `name`.
  if (nonEmptyString(entities.displayName) && flat.name === undefined) {
    flat.name = entities.displayName;
  }
  // send_estimate / send_invoice: classifier emits `sendChannel`, the handlers
  // read `channel` (`ai/tasks/voice-extended-tasks.ts` does the same alias).
  if (nonEmptyString(entities.sendChannel) && flat.channel === undefined) {
    flat.channel = entities.sendChannel;
  }
  // create_standing_instruction: classifier emits `instructionText`
  // (`ExtractedEntities.instructionText`), the contract wants `instruction`
  // (`contracts/standing-instruction.ts`). Without this the spoken text never
  // reaches the payload, so every standing instruction failed the contract on
  // `instruction: Required` and could never be approved (#845).
  if (nonEmptyString(entities.instructionText) && flat.instruction === undefined) {
    flat.instruction = entities.instructionText;
  }
  // create_job: classifier emits `jobTitle` (a NAME for work being created);
  // `createJobPayloadSchema` and `CreateJobExecutionHandler` read `title`.
  // Same precedence as `CreateJobVoiceTaskHandler` (jobTitle → jobReference).
  if (proposalType === 'create_job' && flat.title === undefined) {
    const title = nonEmptyString(entities.jobTitle) ?? nonEmptyString(entities.jobReference);
    if (title) flat.title = title;
  }
  // update_customer: the classifier (and the deterministic owner-command
  // matchers in ai/orchestration/intent-classifier.ts, which emit
  // `updatedPhone`/`updatedAddress` for the two stereotyped phrasings) names
  // the NEW values in `updatedName`/`updatedEmail`/`updatedPhone`/
  // `updatedAddress`; `updateCustomerPayloadSchema` and
  // `UpdateCustomerExecutionHandler` read `name`/`email`/`phone`/`address`.
  // Same mapping, same precedence, as `UpdateCustomerTaskHandler`
  // (ai/tasks/voice-extended-tasks.ts) already performs for the memo/chat
  // leg. Without it the payload validated with NO CHANGE IN IT at all —
  // `updateCustomerPayloadSchema` requires only `customerId` — so an approved
  // "update Khan's email" executed as a silent no-op (register case cust-02).
  for (const [source, target] of UPDATE_CUSTOMER_FIELD_ALIASES) {
    const value = nonEmptyString(entities[source]);
    if (value && flat[target] === undefined) flat[target] = value;
  }

  // The resolved customer every record-linking handler reads off `customerId`.
  const customerId = resolveCustomerId(entities, input.callerCustomerId);
  if (customerId) flat.customerId = customerId;

  // update_job: the operator's spoken status/priority ("... to in progress",
  // "mark it urgent priority"). `update_job` extracts only `jobReference`, so
  // without this the payload reached `updateJobPayloadSchema`'s whole-object
  // "at least one field to change" refine with nothing to change — and that
  // refine carries `path: []`, so `fieldPathsFrom` below could name nothing
  // and the draft was persisted with an EMPTY `missingFields`: an
  // approve-to-fail card (register case job-02). Deterministic, additive
  // (never overwrites a field the drafting leg already set) and non-guessing
  // — see job-edit-phrases.ts.
  if (proposalType === 'update_job' && !hasAnyJobEditField(flat)) {
    const parsed = parseJobEditFields(input.utterance);
    if (parsed.status !== undefined) flat.status = parsed.status;
    if (parsed.priority !== undefined) flat.priority = parsed.priority;
  }

  // send_payment_reminder: an ad-hoc voice reminder is the MANUAL dunning
  // step. `sendPaymentReminderPayloadSchema` requires `stepKey`/`offsetDays`/
  // `channel` — cadence metadata the sweep stamps and a spoken reminder never
  // names — and `SendPaymentReminderExecutionHandler` reads `stepKey ===
  // 'manual'` as its own documented ad-hoc shape (its 72h cooldown, rather
  // than the ledger's per-step key). These are the SAME three defaults
  // `SendPaymentReminderTaskHandler` (ai/tasks/voice-extended-tasks.ts)
  // stamps, including its `sendChannel ?? 'sms'` precedence, so the live-turn
  // and memo legs cannot disagree about what a spoken reminder is.
  if (proposalType === 'send_payment_reminder') {
    if (flat.stepKey === undefined) flat.stepKey = MANUAL_REMINDER_STEP_KEY;
    if (flat.offsetDays === undefined) flat.offsetDays = 0;
    if (flat.channel === undefined) flat.channel = 'sms';
    // The free-text reference the review card resolves when no invoiceId
    // came back — same `jobReference ?? customerName` precedence as the task
    // handler (there is no `invoiceReference` extraction field in the
    // taxonomy; every invoice-doc intent reuses jobReference).
    if (flat.invoiceReference === undefined) {
      const reference =
        nonEmptyString(entities.jobReference) ?? nonEmptyString(entities.customerName);
      if (reference) flat.invoiceReference = reference;
    }
  }

  // send_invoice: preserve the spoken document reference, exactly as
  // `SendInvoiceTaskHandler` does on the memo/chat leg (`ee.jobReference ??
  // ee.customerName`; there is no `invoiceReference` extraction field in the
  // taxonomy — every invoice-doc intent reuses `jobReference`). Without it,
  // "text Smith the invoice link" built a payload naming NO document at all,
  // and `sendInvoicePayloadSchema`'s whole-object refine ("Either invoiceId or
  // invoiceReference is required") then failed with `path: []` — the exact
  // unnameable shape `namedContractGap` exists for. It was masked only while
  // `channel` happened to be absent too, so the gate had something else to
  // name; the moment the classifier extracts a `sendChannel` (which it does,
  // for "TEXT Smith…"), the live-turn leg minted a contract-INVALID
  // send_invoice with an EMPTY gate — an approve-to-fail card, caught by the
  // register's own "mints no approve-to-fail proposal on any surface" guard.
  if (proposalType === 'send_invoice' && flat.invoiceReference === undefined) {
    const reference =
      nonEmptyString(entities.jobReference) ?? nonEmptyString(entities.customerName);
    if (reference) flat.invoiceReference = reference;
  }

  // Whole-object contract refines carry `path: []`, so `fieldPathsFrom` below
  // can name nothing and `missingFieldPaths` comes back EMPTY even when the
  // check fails — leaving the caller with an invalid payload it cannot gate
  // (D01, and the register's `proposal_generation` FAIL signature on job-02 /
  // est-06). Detect each one proactively and name the field an operator
  // fills. See `namedContractGap` for the per-type rationale.
  const contractGapFields: string[] = namedContractGap(proposalType, flat);

  // ── 3. Line items (injected grounding) ────────────────────────────────────
  let lineItemOutcome: VoiceLineItemGrounding | undefined;
  if (GROUNDED_LINE_ITEM_PROPOSAL_TYPES.has(proposalType) && deps.groundLineItems) {
    const descriptions = Array.isArray(entities.lineItemDescriptions)
      ? entities.lineItemDescriptions.filter(
          (d): d is string => typeof d === 'string' && d.trim().length > 0,
        )
      : [];
    if (descriptions.length > 0) {
      lineItemOutcome = await deps.groundLineItems(descriptions);
      if (lineItemOutcome) {
        flat.lineItems = lineItemOutcome.lineItems;
      }
    }
  }

  // ── 4. Envelope ───────────────────────────────────────────────────────────
  // `entities` is preserved verbatim alongside the promoted keys so the review
  // card / audit trail still shows exactly what the classifier heard.
  const payload: Record<string, unknown> = {
    ...flat,
    ...(lineItemOutcome?.meta ? { _meta: lineItemOutcome.meta } : {}),
    intent,
    entities,
    sessionId: envelope.sessionId,
    ...(envelope.callSid !== undefined ? { callSid: envelope.callSid } : {}),
    ...(envelope.conversationId !== undefined
      ? { conversationId: envelope.conversationId }
      : {}),
  };

  // ── 5. The contract gate ──────────────────────────────────────────────────
  const confidence = lineItemOutcome?.confidenceScore ?? input.confidence;
  const common = {
    payload,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(lineItemOutcome ? { lineItemOutcome } : {}),
  };

  const validation = validateProposalPayload(proposalType, payload);
  if (!validation.valid) {
    const errors = validation.errors ?? ['payload failed contract validation'];
    // D01 — merge in the whole-object-refine gap `fieldPathsFrom` cannot
    // name (see contractGapFields above); deduped, since a payload can also
    // independently fail a field-specific check (e.g. scheduledStart).
    const missingFieldPaths = [...new Set([...fieldPathsFrom(errors), ...contractGapFields])];
    return { ...common, ok: false, errors, missingFieldPaths };
  }

  // A contract-VALID payload can still be unapprovable — see
  // `missingFieldPaths` on the result type, and `namedContractGap`'s
  // `update_customer` case.
  return { ...common, ok: true, missingFieldPaths: contractGapFields };
}

/**
 * `validateProposalPayload` returns `"<zod path>: <message>"`. Keep the FIRST
 * path segment (`lineItems[0].unitPrice` → `lineItems`) because that is the
 * flat payload key an operator edits and `clearSatisfiedMissingFields` matches
 * on. Whole-object refine failures carry an empty path and are dropped — see
 * `missingFieldPaths` on the result type for why.
 */
function fieldPathsFrom(errors: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const error of errors) {
    const path = error.slice(0, error.indexOf(':'));
    if (!path) continue;
    const head = path.split('.')[0]?.replace(/\[\d+\]$/, '');
    if (head) paths.add(head);
  }
  return [...paths];
}
