import type { EntityAliasRepository } from '../../learning/entity-aliases/entity-alias';
import { adoptEntityAliasPayloadSchema } from '../contracts/adopt-entity-alias';
import type { Proposal, ProposalType } from '../proposal';
import type {
  ExecutionContext,
  ExecutionHandler,
  ExecutionResult,
} from './handlers';

/**
 * Activates a learned alias only after the proposal executor has observed an
 * owner-approved adopt_entity_alias proposal. The repository revalidates the
 * approved proposal, canonical actor, tenant target, and grounding source
 * inside its transaction.
 */
export class EntityAliasExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'adopt_entity_alias';

  constructor(private readonly repo?: EntityAliasRepository) {}

  isFullyWired(): boolean {
    return Boolean(this.repo);
  }

  async execute(
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    if (proposal.resultEntityId) {
      return { success: true, resultEntityId: proposal.resultEntityId };
    }
    if (!adoptEntityAliasPayloadSchema.safeParse(proposal.payload).success) {
      return {
        success: false,
        error: 'Approved entity alias proposal has an invalid payload',
      };
    }
    if (!this.repo) {
      return {
        success: false,
        error: 'handler_not_wired:entityAliasRepo',
      };
    }

    try {
      const alias = await this.repo.activateFromApprovedProposal({
        tenantId: context.tenantId,
        approvalProposalId: proposal.id,
        activatedBy: context.executedBy,
        actorRole: 'owner',
      });
      return { success: true, resultEntityId: alias.id };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Entity alias activation failed',
      };
    }
  }
}
