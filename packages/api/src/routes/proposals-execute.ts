import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { ProposalRepository } from '../proposals/proposal';
import {
  createCustomer,
  CustomerRepository,
} from '../customers/customer';
import { AuditRepository } from '../audit/audit';

export interface ProposalExecutionDeps {
  proposalRepo: ProposalRepository;
  customerRepo: CustomerRepository;
  auditRepo: AuditRepository;
}

/**
 * Execute a proposal by its ID. Updates proposal status to 'executed'
 * and performs the action based on proposal type.
 */
async function executeProposal(
  tenantId: string,
  proposalId: string,
  userId: string,
  userRole: string,
  deps: ProposalExecutionDeps
) {
  const proposal = await deps.proposalRepo.findById(tenantId, proposalId);

  if (!proposal) {
    throw new Error('Proposal not found');
  }

  if (proposal.status === 'executed') {
    throw new Error('Proposal has already been executed');
  }

  if (proposal.status === 'rejected' || proposal.status === 'undone') {
    throw new Error('Proposal cannot be executed in current status: ' + proposal.status);
  }

  let resultEntityId: string | undefined;

  if (proposal.proposalType === 'create_customer') {
    const payload = proposal.payload as Record<string, unknown>;
    const fullName = typeof payload.name === 'string' ? payload.name : '';
    const nameParts = fullName.split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const customerData = {
      firstName: firstName || 'Unknown',
      lastName: lastName || 'Customer',
      email: typeof payload.email === 'string' ? payload.email : undefined,
      primaryPhone: typeof payload.phone === 'string' ? payload.phone : undefined,
      tenantId,
      createdBy: userId,
      actorRole: userRole,
    };

    const customer = await createCustomer(customerData, deps.customerRepo, deps.auditRepo);
    resultEntityId = customer.id;
  }

  const updatedProposal = await deps.proposalRepo.updateStatus(
    tenantId,
    proposalId,
    'executed',
    {
      executedAt: new Date(),
      executedBy: userId,
      resultEntityId,
    }
  );

  if (!updatedProposal) {
    throw new Error('Failed to update proposal status');
  }

  return updatedProposal;
}

export function createProposalExecutionRouter(deps: ProposalExecutionDeps): Router {
  const router = Router();

  router.post(
    '/:id/execute',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await executeProposal(
        req.auth!.tenantId,
        req.params.id,
        req.auth!.userId,
        req.auth!.role,
        deps
      );
      res.json(result);
    })
  );

  router.post(
    '/:id/approve',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const proposal = await deps.proposalRepo.findById(req.auth!.tenantId, req.params.id);
      if (!proposal) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Proposal not found' });
        return;
      }

      await deps.proposalRepo.updateStatus(
        req.auth!.tenantId,
        req.params.id,
        'approved',
        {
          approvedAt: new Date(),
        }
      );

      const result = await executeProposal(
        req.auth!.tenantId,
        req.params.id,
        req.auth!.userId,
        req.auth!.role,
        deps
      );
      res.json(result);
    })
  );

  return router;
}
