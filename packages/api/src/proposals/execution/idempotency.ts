import { Proposal, ProposalRepository } from '../proposal';
import { ExecutionResult } from './handlers';
import { ConflictError } from '../../shared/errors';

export class IdempotencyGuard {
  constructor(private readonly proposalRepo: ProposalRepository) {}

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
      proposal.idempotencyKey
    );

    if (previous) {
      const result: ExecutionResult = {
        success: true,
        resultEntityId: previous.resultEntityId,
      };
      return { result, alreadyExecuted: true };
    }

    const result = await executeFn();
    return { result, alreadyExecuted: false };
  }

  async findPreviousExecution(
    tenantId: string,
    idempotencyKey: string
  ): Promise<Proposal | null> {
    const proposals = await this.proposalRepo.findByTenant(tenantId);
    const match = proposals.find(
      (p) => p.idempotencyKey === idempotencyKey && p.status === 'executed'
    );
    return match ?? null;
  }
}
