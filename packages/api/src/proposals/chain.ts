import { Proposal, ProposalType } from './proposal';

/**
 * Multi-action chaining — shared types + helpers.
 *
 * A single voice utterance ("create a customer named Jane, book her a
 * tune-up Tuesday, and send her an estimate") decomposes into an
 * ORDERED chain of proposals. Later members of the chain often depend
 * on an entity an EARLIER member creates but hasn't created yet — the
 * appointment needs the customer's id, but the create_customer proposal
 * won't execute until it's approved.
 *
 * We bridge that gap with a symbolic reference token written into the
 * dependent proposal's payload:
 *
 *     $ref:chain[0].customerId
 *
 * meaning "use the resultEntityId of the chain sibling at index 0 as
 * the customerId here." The token is resolved at EXECUTION time, after
 * the parent executes and exposes its resultEntityId
 * (see execution/chain-resolution.ts).
 *
 * Chain metadata rides on `sourceContext` (JSONB) so no schema change
 * is needed for the per-proposal bits — same precedent as
 * `missingFields` (proposal.ts). The only column added is `chain_id`,
 * for an indexed sibling lookup at execution time.
 */

/**
 * The kind of entity a parent proposal contributes to a dependent.
 * Always an id — the dependent reads the parent's `resultEntityId`.
 */
export type ChainEntityKind =
  | 'customerId'
  | 'jobId'
  | 'estimateId'
  | 'invoiceId'
  | 'appointmentId'
  | 'leadId';

export const CHAIN_ENTITY_KINDS: readonly ChainEntityKind[] = [
  'customerId',
  'jobId',
  'estimateId',
  'invoiceId',
  'appointmentId',
  'leadId',
] as const;

/**
 * A single resolved dependency edge stored on a dependent proposal's
 * `sourceContext.chainRefs`. Structured so the executor never has to
 * scan arbitrary payload values for tokens.
 */
export interface ChainRef {
  /** Payload key that holds the token, e.g. 'customerId' or 'jobId'. */
  payloadPath: string;
  /** Which earlier chain sibling supplies the value (0-based). */
  parentChainIndex: number;
  /** What kind of id is expected — drives the resolver's substitution. */
  entityKind: ChainEntityKind;
}

/**
 * Chain metadata as carried on `sourceContext`. All members of a chain
 * share `chainId` + `chainLength`; each has its own `chainIndex`.
 */
export interface ChainMeta {
  chainId: string;
  chainIndex: number;
  chainLength: number;
  dependsOnChainIndices: number[];
  chainRefs: ChainRef[];
}

const CHAIN_REF_TOKEN_PREFIX = '$ref:chain[';

/**
 * Build a symbolic reference token for a dependent payload field.
 * e.g. buildChainRefToken(0, 'customerId') === '$ref:chain[0].customerId'
 */
export function buildChainRefToken(
  parentChainIndex: number,
  entityKind: ChainEntityKind
): string {
  return `${CHAIN_REF_TOKEN_PREFIX}${parentChainIndex}].${entityKind}`;
}

/**
 * Parse a symbolic reference token. Returns null when the value is not
 * a token (the common case — most payload values are concrete). Keeps
 * the resolver branchy-but-cheap: it only acts when parse returns a hit.
 */
export function parseChainRefToken(
  value: unknown
): { parentChainIndex: number; entityKind: ChainEntityKind } | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(CHAIN_REF_TOKEN_PREFIX)) return null;
  const match = /^\$ref:chain\[(\d+)\]\.([a-zA-Z]+)$/.exec(value);
  if (!match) return null;
  const parentChainIndex = Number(match[1]);
  const entityKind = match[2] as ChainEntityKind;
  if (!Number.isInteger(parentChainIndex) || parentChainIndex < 0) return null;
  if (!CHAIN_ENTITY_KINDS.includes(entityKind)) return null;
  return { parentChainIndex, entityKind };
}

export function isChainRefToken(value: unknown): boolean {
  return parseChainRefToken(value) !== null;
}

// A syntactically-valid placeholder UUID used only to satisfy Zod
// uuid() validation for a payload field still holding an unresolved
// chain-ref token. It is never persisted — see
// payloadForValidation — the real token is kept on the proposal and
// substituted with the parent's resultEntityId at execution time.
const CHAIN_REF_PLACEHOLDER_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * Produce a copy of a payload safe to run through the Zod contract for
 * validation, substituting any unresolved chain-ref token with a
 * placeholder UUID. The chain-ref fields target uuid-typed contract
 * fields (customerId, jobId, …); the literal `$ref:chain[..]` token
 * would fail `z.string().uuid()`, so editing a chained dependent (which
 * re-validates the merged payload) would spuriously throw. The token is
 * a by-construction value the executor resolves — it is not the
 * operator's concern — so we validate around it. Non-chained payloads
 * pass through unchanged (no allocation when there is nothing to swap).
 */
export function payloadForValidation(
  payload: Record<string, unknown>
): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(payload)) {
    if (isChainRefToken(value)) {
      copy = copy ?? { ...payload };
      copy[key] = CHAIN_REF_PLACEHOLDER_UUID;
    }
  }
  return copy ?? payload;
}

/**
 * Typed accessor for the chain metadata stashed on `sourceContext`.
 * Mirrors `missingFieldsFor` — keeps the JSONB read in one place with
 * the correct type. Returns undefined for non-chained proposals.
 */
export function chainMetaFor(proposal: Proposal): ChainMeta | undefined {
  const ctx = proposal.sourceContext as Record<string, unknown> | undefined;
  if (!ctx) return undefined;
  const chainId = ctx.chainId ?? proposal.chainId;
  if (typeof chainId !== 'string') return undefined;
  const chainIndex = ctx.chainIndex;
  const chainLength = ctx.chainLength;
  if (typeof chainIndex !== 'number' || typeof chainLength !== 'number') {
    return undefined;
  }
  const dependsOnChainIndices = Array.isArray(ctx.dependsOnChainIndices)
    ? ctx.dependsOnChainIndices.filter((n): n is number => typeof n === 'number')
    : [];
  const chainRefs = Array.isArray(ctx.chainRefs)
    ? (ctx.chainRefs.filter(isValidChainRef) as ChainRef[])
    : [];
  return { chainId, chainIndex, chainLength, dependsOnChainIndices, chainRefs };
}

function isValidChainRef(value: unknown): value is ChainRef {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.payloadPath === 'string' &&
    typeof r.parentChainIndex === 'number' &&
    typeof r.entityKind === 'string' &&
    CHAIN_ENTITY_KINDS.includes(r.entityKind as ChainEntityKind)
  );
}

export function isChained(proposal: Proposal): boolean {
  return chainMetaFor(proposal) !== undefined;
}

/**
 * Maps (proposalType, entityKind) → the payload key that should hold
 * the reference token. The router consults this when wiring a
 * dependency edge so the token lands in the field the execution handler
 * actually reads. A proposal type that can't consume a given entity
 * kind simply has no entry, and the router skips the edge (the
 * decomposer over-suggested).
 *
 * Note create_appointment consumes a jobId (not a customerId) — booking
 * a brand-new customer therefore requires an intermediate create_job
 * segment; the decomposer is taught to emit one.
 */
export const ENTITY_KIND_TO_PAYLOAD_PATH: Partial<
  Record<ProposalType, Partial<Record<ChainEntityKind, string>>>
> = {
  create_job: { customerId: 'customerId' },
  create_appointment: { jobId: 'jobId' },
  draft_estimate: { customerId: 'customerId', jobId: 'jobId' },
  draft_invoice: { customerId: 'customerId', jobId: 'jobId', estimateId: 'estimateId' },
  add_service_location: { customerId: 'customerId' },
  // NOTE: add_note is intentionally absent. Its contract has no
  // customerId/jobId field — it targets a record via targetKind +
  // targetId/targetReference (contracts/notes.ts). Writing a chain-ref
  // token into a non-existent payload field would silently attach the
  // note to nothing. A chained note therefore degrades to a standalone
  // note the operator resolves at review (targetReference/missingFields).
};

/**
 * Resolve the payload path for a dependency edge, or undefined when the
 * dependent proposal type can't consume the supplied entity kind.
 */
export function payloadPathFor(
  proposalType: ProposalType,
  entityKind: ChainEntityKind
): string | undefined {
  return ENTITY_KIND_TO_PAYLOAD_PATH[proposalType]?.[entityKind];
}

/**
 * Stamp chain metadata onto a freshly-built proposal IN PLACE, before it
 * is persisted. The router calls this after a task handler produces the
 * proposal, once the loop knows the chain id/index and the dependency
 * edges for this segment.
 *
 * For each dependency edge it:
 *   - writes a symbolic ref token into the dependent payload field that
 *     the execution handler reads (e.g. payload.customerId =
 *     '$ref:chain[0].customerId'), and
 *   - records the edge in sourceContext.chainRefs (structured, so the
 *     resolver never scans the payload).
 *
 * A chain-ref field is deliberately NOT added to `missingFields`: it is
 * filled automatically at execution time from the parent, so the
 * operator has nothing to resolve. Treating it as a missing field would
 * (a) block the operator from approving the dependent and (b) leave it
 * stuck in 'draft' with no path forward. Instead the dependent is forced
 * to 'draft' directly so it can't auto-approve/execute ahead of its
 * parent; the execution-time resolution gate is the actual ordering
 * guarantee. The parent itself (refs empty) keeps whatever status
 * createProposal decided.
 */
export function applyChainMetadata(
  proposal: Proposal,
  meta: {
    chainId: string;
    chainIndex: number;
    chainLength: number;
    dependsOnChainIndices: number[];
    chainRefs: ChainRef[];
  }
): void {
  proposal.chainId = meta.chainId;

  const existingCtx = (proposal.sourceContext as Record<string, unknown> | undefined) ?? {};

  // Write ref tokens into the dependent payload fields. These resolve to
  // the parent's resultEntityId at execution time — they are not operator
  // gaps, so they are intentionally kept out of missingFields.
  //
  // Only overwrite a field the handler left empty: if the handler already
  // extracted a concrete value (e.g. an explicit "invoice for job #4821"),
  // that real value wins over a symbolic ref to a sibling.
  const wiredRefs: ChainRef[] = [];
  for (const ref of meta.chainRefs) {
    const current = proposal.payload[ref.payloadPath];
    if (current !== undefined && current !== null && current !== '') {
      continue;
    }
    proposal.payload[ref.payloadPath] = buildChainRefToken(ref.parentChainIndex, ref.entityKind);
    wiredRefs.push(ref);
  }

  proposal.sourceContext = {
    ...existingCtx,
    chainId: meta.chainId,
    chainIndex: meta.chainIndex,
    chainLength: meta.chainLength,
    dependsOnChainIndices: meta.dependsOnChainIndices,
    // Persist only the edges we actually wired — a ref we skipped (the
    // handler already had a concrete value) must NOT be resolved at
    // execution time, or it would clobber that value.
    chainRefs: wiredRefs,
  };

  // Any proposal that depends on an earlier chain member must wait for
  // operator approval + its parent's execution — it can never auto-approve
  // or execute ahead of its parent. We force 'draft' whenever this segment
  // declares a dependency (dependsOnChainIndices non-empty), NOT only when
  // a ref token was wired: a dependent whose (type, entityKind) isn't in
  // ENTITY_KIND_TO_PAYLOAD_PATH still must not race ahead. Forcing 'draft'
  // here (rather than via missingFields) keeps it approvable by the operator
  // while still blocking auto-execution.
  if (meta.dependsOnChainIndices.length > 0) {
    proposal.status = 'draft';
    proposal.approvedAt = undefined;
  }
}
