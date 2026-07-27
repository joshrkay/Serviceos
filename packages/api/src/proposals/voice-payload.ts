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
} & (
  | { ok: true }
  | {
      ok: false;
      /** `path: message`, straight from `validateProposalPayload`. */
      errors: string[];
      /**
       * Top-level payload keys the contract complained about, deduped — the
       * exact flat keys `clearSatisfiedMissingFields` (proposals/actions.ts)
       * lifts when an operator edits them, so they are safe to use as a
       * `missingFields` approval gate. EMPTY when every failure was a
       * whole-object refine with no field path: nothing nameable for an
       * operator to fill, so the caller should degrade instead of gating.
       */
      missingFieldPaths: string[];
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
  // create_job: classifier emits `jobTitle` (a NAME for work being created);
  // `createJobPayloadSchema` and `CreateJobExecutionHandler` read `title`.
  // Same precedence as `CreateJobVoiceTaskHandler` (jobTitle → jobReference).
  if (proposalType === 'create_job' && flat.title === undefined) {
    const title = nonEmptyString(entities.jobTitle) ?? nonEmptyString(entities.jobReference);
    if (title) flat.title = title;
  }
  // The resolved customer every record-linking handler reads off `customerId`.
  const customerId = resolveCustomerId(entities, input.callerCustomerId);
  if (customerId) flat.customerId = customerId;

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
    return { ...common, ok: false, errors, missingFieldPaths: fieldPathsFrom(errors) };
  }

  return { ...common, ok: true };
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
