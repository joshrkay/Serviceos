import { Proposal, ProposalRepository } from '../proposal';
import { chainMetaFor, parseChainRefToken } from '../chain';

/**
 * Execution-time resolver for multi-action chains.
 *
 * A dependent proposal carries symbolic reference tokens
 * (`$ref:chain[0].customerId`) in its payload. Before its execution
 * handler runs, we swap each token for the concrete `resultEntityId` of
 * the chain sibling it depends on — but only once that sibling has
 * actually executed.
 *
 * The resolver is the ORDERING GUARANTEE for chains. The execution
 * sweep may claim a dependent before its parent; the resolver returns
 * `blocked: parent_pending`, the executor surfaces a retryable error,
 * and the next sweep tick re-attempts after the parent has executed.
 * Correctness therefore does NOT depend on the sweep's claim order.
 */

export interface ChainResolutionDeps {
  proposalRepo: ProposalRepository;
}

export type ChainResolution =
  | { status: 'resolved'; payload: Record<string, unknown> }
  | { status: 'blocked'; reason: 'parent_pending' | 'parent_failed'; parentId: string }
  // Not a chained proposal, or a chained proposal with no unresolved
  // refs — behave exactly as before (backward compatible).
  | { status: 'noop' };

export async function resolveChainReferences(
  proposal: Proposal,
  deps: ChainResolutionDeps
): Promise<ChainResolution> {
  const meta = chainMetaFor(proposal);
  if (!meta || meta.chainRefs.length === 0) {
    return { status: 'noop' };
  }

  const siblings = await deps.proposalRepo.findByChain(proposal.tenantId, meta.chainId);
  const byIndex = new Map<number, Proposal>();
  for (const s of siblings) {
    const sMeta = chainMetaFor(s);
    if (sMeta) byIndex.set(sMeta.chainIndex, s);
  }

  // Work on a shallow copy so a blocked resolution never mutates the
  // proposal the caller still holds.
  const payload: Record<string, unknown> = { ...proposal.payload };

  for (const ref of meta.chainRefs) {
    const current = payload[ref.payloadPath];
    // Only act on values that are still unresolved tokens. A field the
    // operator already resolved by hand at review time is left alone.
    if (!parseChainRefToken(current)) continue;

    const parent = byIndex.get(ref.parentChainIndex);
    if (!parent) {
      // Parent missing entirely (e.g. it was a clarification, not a
      // proposal). Treat as a permanent failure for this dependent.
      return { status: 'blocked', reason: 'parent_failed', parentId: '(missing)' };
    }

    if (parent.status === 'executed') {
      if (parent.resultEntityId) {
        payload[ref.payloadPath] = parent.resultEntityId;
        continue;
      }
      // Executed but produced no entity to reference. The parent will
      // never run again, so 'parent_pending' would retry forever — this
      // is a permanent failure. Cascade-fail the dependent.
      return { status: 'blocked', reason: 'parent_failed', parentId: parent.id };
    }

    if (parent.status === 'execution_failed' || parent.status === 'rejected' ||
        parent.status === 'expired' || parent.status === 'undone') {
      return { status: 'blocked', reason: 'parent_failed', parentId: parent.id };
    }

    // Parent exists but hasn't executed yet (draft / ready_for_review /
    // approved / executing).
    return { status: 'blocked', reason: 'parent_pending', parentId: parent.id };
  }

  return { status: 'resolved', payload };
}
