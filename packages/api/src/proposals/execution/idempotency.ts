import { Proposal, ProposalRepository } from '../proposal';
import { ProposalExecutionRepository } from '../proposal-execution';
import { ExecutionResult } from './handlers';

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
  ) {}

  async checkAndExecute(
    proposal: Proposal,
    executeFn: () => Promise<ExecutionResult>
  ): Promise<{ result: ExecutionResult; alreadyExecuted: boolean }> {
    if (!proposal.idempotencyKey) {
      const result = await executeFn();
      return { result, alreadyExecuted: false };
    }

    const previous = await this.findPreviousExecution(
      proposal.tenantId,
      proposal.idempotencyKey,
    );

    if (previous) {
      return {
        result: { success: true, resultEntityId: previous.resultEntityId },
        alreadyExecuted: true,
      };
    }

    const result = await executeFn();
    return { result, alreadyExecuted: false };
  }

  /**
   * Finds the previously-executed proposal for the given (tenant, idempotencyKey).
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
