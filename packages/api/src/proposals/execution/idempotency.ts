import type { PoolClient } from 'pg';
import { Proposal, ProposalRepository } from '../proposal';
import { ProposalExecutionRepository } from '../proposal-execution';
import { ExecutionResult } from './handlers';
import {
  IdempotencyLockProvider,
  NoOpIdempotencyLockProvider,
} from './idempotency-lock';

/** Stable per-proposal key when callers omit `idempotencyKey` (§11 H1). */
export function resolveProposalIdempotencyKey(proposal: Proposal): string {
  return (
    proposal.idempotencyKey ?? `proposal-run:${proposal.tenantId}:${proposal.id}`
  );
}

export function withResolvedIdempotencyKey(proposal: Proposal): Proposal {
  const idempotencyKey = resolveProposalIdempotencyKey(proposal);
  if (proposal.idempotencyKey === idempotencyKey) return proposal;
  return { ...proposal, idempotencyKey };
}

/**
 * Guards proposal execution against duplicate side effects when callers
 * supply an `idempotencyKey`. The lookup is indexed on
 * `proposal_executions (tenant_id, idempotency_key) WHERE idempotency_key
 * IS NOT NULL` (migration 099) — O(1) practical cost regardless of tenant
 * size. The previous implementation scanned every proposal in the tenant
 * (O(n)) and would degrade as a tenant accumulated history.
 */
export class IdempotencyGuard {
  constructor(
    private readonly executionRepo: ProposalExecutionRepository,
    private readonly proposalRepo: ProposalRepository,
    private readonly lock: IdempotencyLockProvider = new NoOpIdempotencyLockProvider(),
  ) {}

  async checkAndExecute(
    proposal: Proposal,
    executeFn: (client?: PoolClient) => Promise<ExecutionResult>
  ): Promise<{ result: ExecutionResult; alreadyExecuted: boolean }> {
    const keyed = withResolvedIdempotencyKey(proposal);
    const idempotencyKey = keyed.idempotencyKey!;

    return this.lock.withLock(keyed.tenantId, idempotencyKey, async (client) => {
      // Read the idempotency marker BEFORE opening any transaction: the
      // advisory lock serializes callers, and a prior run committed its marker
      // before releasing the lock, so this read always sees the latest.
      const previous = await this.findPreviousExecution(
        keyed.tenantId,
        idempotencyKey,
      );

      if (previous) {
        return {
          result: { success: true, resultEntityId: previous.resultEntityId },
          alreadyExecuted: true,
        };
      }

      // DATA-31: pass the locked connection through so the executor can run the
      // handler mutation + idempotency record + status transition in one
      // transaction on this session, committed before the lock releases.
      const result = await executeFn(client);
      return { result, alreadyExecuted: false };
    });
  }

  /**
   * Finds the previously-executed proposal for the given (tenant, idempotencyKey).
   *
   * Note: the returned `Proposal.resultEntityId` may be undefined if the
   * original execution did not set it — callers should treat that case
   * as a passthrough success (consistent with how the cache-hit branch
   * in `checkAndExecute` works).
   *
   * Looks up the `proposal_executions` row via the partial unique index
   * (`proposal_executions_tenant_idempotency_uniq`, migration 099), then
   * loads the parent proposal to read `resultEntityId` — which lives on
   * `proposals`, not on `proposal_executions`. Returns null if no
   * succeeded execution exists for the key, or (defensively) if the
   * parent proposal cannot be loaded.
   */
  async findPreviousExecution(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Proposal | null> {
    const execution = await this.executionRepo.findByIdempotencyKey(
      tenantId,
      idempotencyKey,
    );
    if (!execution) return null;
    return this.proposalRepo.findById(tenantId, execution.proposalId);
  }
}
