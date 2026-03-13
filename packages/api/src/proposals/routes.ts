import { Proposal, ProposalRepository } from './proposal';
import { ProposalFilter, proposalFilterSchema } from './proposal-contracts';
import { NotFoundError, ForbiddenError } from '../shared/errors';
import { validate, uuidSchema } from '../shared/validation';
import { Role, hasPermission } from '../auth/rbac';

export async function listProposals(
  proposalRepo: ProposalRepository,
  tenantId: string,
  filter: ProposalFilter,
  actorRole: Role
): Promise<{ data: Proposal[]; total: number }> {
  if (!hasPermission(actorRole, 'proposals:view')) {
    throw new ForbiddenError();
  }

  const validFilter = validate(proposalFilterSchema, filter);

  let proposals: Proposal[];
  if (validFilter.status) {
    proposals = await proposalRepo.findByStatus(tenantId, validFilter.status);
  } else {
    proposals = await proposalRepo.findByTenant(tenantId);
  }

  if (validFilter.proposalType) {
    proposals = proposals.filter((p) => p.proposalType === validFilter.proposalType);
  }

  const total = proposals.length;
  const offset = validFilter.offset ?? 0;
  const limit = validFilter.limit ?? 20;
  const data = proposals.slice(offset, offset + limit);

  return { data, total };
}

export async function getProposalDetail(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorRole: Role
): Promise<Proposal> {
  validate(uuidSchema, proposalId);

  if (!hasPermission(actorRole, 'proposals:view')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  return proposal;
}
