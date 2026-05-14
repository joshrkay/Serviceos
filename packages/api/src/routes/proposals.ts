import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { validate } from '../shared/validation';
import { Role } from '../auth/rbac';
import { ProposalRepository } from '../proposals/proposal';
import { AppointmentRepository } from '../appointments/appointment';
import { ProposalFilter } from '../proposals/proposal-contracts';
import { listProposals, getProposalDetail } from '../proposals/routes';
import {
  approveProposal,
  rejectProposal,
  editProposal,
  undoProposal,
} from '../proposals/actions';
import {
  proposalFilterSchema,
  rejectProposalBodySchema,
  editProposalBodySchema,
} from '../proposals/proposal-contracts';

export function createProposalsRouter(
  proposalRepo: ProposalRepository,
  appointmentRepo?: AppointmentRepository,
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('proposals:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const filter = validate(proposalFilterSchema, req.query) as ProposalFilter;
        const result = await listProposals(
          proposalRepo,
          req.auth!.tenantId,
          filter,
          req.auth!.role as Role
        );
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('proposals:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getProposalDetail(
          proposalRepo,
          req.auth!.tenantId,
          req.params.id,
          req.auth!.role as Role
        );
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/approve',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await approveProposal(
          proposalRepo,
          req.auth!.tenantId,
          req.params.id,
          req.auth!.userId,
          req.auth!.role as Role
        );
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/reject',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = validate(rejectProposalBodySchema, req.body);
        const result = await rejectProposal(
          proposalRepo,
          req.auth!.tenantId,
          req.params.id,
          req.auth!.userId,
          req.auth!.role as Role,
          parsed.reason,
          parsed.details,
          appointmentRepo
        );
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/undo',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await undoProposal(
          proposalRepo,
          req.auth!.tenantId,
          req.params.id,
          req.auth!.userId,
          req.auth!.role as Role
        );
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('proposals:edit'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = validate(editProposalBodySchema, req.body);
        const result = await editProposal(
          proposalRepo,
          req.auth!.tenantId,
          req.params.id,
          req.auth!.userId,
          req.auth!.role as Role,
          parsed.edits
        );
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
