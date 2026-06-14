import { Proposal, ProposalType } from './proposal';
import type { AddNotePayload } from './contracts/notes';

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
 *
 * RV-220 — coverage audit for "new types":
 *   - send_estimate / send_invoice / issue_invoice / record_payment are
 *     covered below. They are the canonical chain tails ("draft the
 *     estimate and send it") and each consumes exactly one id its
 *     contract already declares (estimateId / invoiceId). Their
 *     comms/money action class is untouched — chained or not, they never
 *     auto-approve (decideInitialStatus) and the chain SMS lists them as
 *     "approval follows separately" (RV-221).
 *   - attach_photos, create_agreement, apply_route_plan (named by the
 *     architect plan for this story) are intentionally ABSENT: none of
 *     them exists as a ProposalType in this codebase (RV-022 — which
 *     would introduce attach_photos + its contract — is unimplemented),
 *     so there is no payload schema or execution handler to consume a
 *     ref. This map is keyed by ProposalType, which makes premature
 *     entries a compile error by design; wire them when the types land.
 *   - create_booking is deliberately not covered: it confirms an
 *     ALREADY-HELD appointment slot created by the live booking path —
 *     chaining it after create_appointment would double-book.
 */
export const ENTITY_KIND_TO_PAYLOAD_PATH: Partial<
  Record<ProposalType, Partial<Record<ChainEntityKind, string>>>
> = {
  create_job: { customerId: 'customerId' },
  create_appointment: { jobId: 'jobId' },
  draft_estimate: { customerId: 'customerId', jobId: 'jobId' },
  draft_invoice: { customerId: 'customerId', jobId: 'jobId', estimateId: 'estimateId' },
  add_service_location: { customerId: 'customerId' },
  // Two refs into one add_note would overwrite targetId/targetKind; the decomposer does not wire that shape today.
  add_note: {
    customerId: 'targetId',
    jobId: 'targetId',
    invoiceId: 'targetId',
    estimateId: 'targetId',
    appointmentId: 'targetId',
  },
  // RV-220 — comms/money chain tails. The contract fields are
  // `.uuid().optional()` + reference fallback; the ref token transiently
  // occupies the id field until execution-time resolution swaps in the
  // parent's resultEntityId (same precedent as draft_estimate.customerId).
  send_estimate: { estimateId: 'estimateId' },
  send_invoice: { invoiceId: 'invoiceId' },
  issue_invoice: { invoiceId: 'invoiceId' },
  record_payment: { invoiceId: 'invoiceId' },
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
  for (const ref of meta.chainRefs) {
    proposal.payload[ref.payloadPath] = buildChainRefToken(ref.parentChainIndex, ref.entityKind);
    if (proposal.proposalType === 'add_note' && ref.payloadPath === 'targetId') {
      proposal.payload.targetKind = targetKindForNoteRef(ref.entityKind);
    }
  }

  proposal.sourceContext = {
    ...existingCtx,
    chainId: meta.chainId,
    chainIndex: meta.chainIndex,
    chainLength: meta.chainLength,
    dependsOnChainIndices: meta.dependsOnChainIndices,
    chainRefs: meta.chainRefs,
  };

  // A dependent with unresolved refs must wait for operator approval +
  // its parent's execution — never auto-approve ahead of the parent.
  // Forcing 'draft' here (rather than via missingFields) keeps it
  // approvable by the operator while still blocking auto-execution.
  if (meta.chainRefs.length > 0) {
    proposal.status = 'draft';
    proposal.approvedAt = undefined;
  }
}

function targetKindForNoteRef(entityKind: ChainEntityKind): AddNotePayload['targetKind'] {
  switch (entityKind) {
    case 'customerId':
      return 'customer';
    case 'jobId':
      return 'job';
    case 'invoiceId':
      return 'invoice';
    case 'estimateId':
      return 'estimate';
    case 'appointmentId':
      return 'appointment';
    case 'leadId':
      throw new Error('add_note chain refs do not support leadId');
  }
}
