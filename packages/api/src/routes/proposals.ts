import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { validate } from '../shared/validation';
import { Role } from '../auth/rbac';
import { ProposalRepository } from '../proposals/proposal';
import { AppointmentRepository } from '../appointments/appointment';
import { AuditRepository } from '../audit/audit';
import { ProposalFilter } from '../proposals/proposal-contracts';
import { buildInboxPayload } from '../proposals/inbox';
import { listProposals, getProposalDetail } from '../proposals/routes';
import {
  approveProposal,
  approveProposalsBatch,
  rejectProposal,
  editProposal,
  undoProposal,
} from '../proposals/actions';
import {
  proposalFilterSchema,
  rejectProposalBodySchema,
  editProposalBodySchema,
} from '../proposals/proposal-contracts';
import { FeasibilityDependencies } from '../scheduling/feasibility-types';
import { createSchedulingProposal } from '../proposals/create-scheduling';

// P2-035 — Batch approval body schema. Lives inline rather than in
// proposal-contracts.ts so this story stays within its allowed-files
// budget. The 50-ID cap bounds blast radius — the inbox UI's "APPROVE
// ALL" affordance is gated client-side on a 3+ threshold, so 50 leaves
// plenty of headroom for the realistic batch sizes without letting a
// scripted caller flood approval audit rows.
const approveBatchBodySchema = z.object({
  proposalIds: z.array(z.string().uuid()).min(1).max(50),
});

export function createProposalsRouter(
  proposalRepo: ProposalRepository,
  appointmentRepo?: AppointmentRepository,
  auditRepo?: AuditRepository,
  feasibilityDeps?: FeasibilityDependencies,
): Router {
  const router = Router();

  // NEW: bare POST handler for scheduling proposal creation (reschedule/reassign).
  // MUST be registered before any '/:id' routes so Express does not mistake the
  // empty segment as an :id param. Scoped to scheduling types only — AI-originated
  // proposal types are created via the LLM gateway, not this HTTP path.
  router.post(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as { proposalType?: string; payload?: any; summary?: string; appointmentVersion?: string };
        const SUPPORTED_TYPES = [
          'reschedule_appointment',
          'reassign_appointment',
          'add_crew_member',
          'remove_crew_member',
        ] as const;
        type SupportedType = (typeof SUPPORTED_TYPES)[number];
        if (!SUPPORTED_TYPES.includes(body.proposalType as SupportedType)) {
          res.status(400).json({ error: 'UNSUPPORTED_PROPOSAL_TYPE', proposalType: body.proposalType });
          return;
        }
        if (!appointmentRepo || !feasibilityDeps) {
          res.status(500).json({ error: 'SCHEDULING_DEPS_UNCONFIGURED' });
          return;
        }
        // If-Match header takes precedence over body.appointmentVersion, consistent
        // with HTTP semantics. The client hook (useCreateScheduleProposal) sends
        // the header; the body field is a fallback for non-browser callers.
        const headerVersion = req.header('If-Match') ?? null;
        const expectedVersion = headerVersion ?? body.appointmentVersion ?? null;

        const result = await createSchedulingProposal(
          {
            tenantId: req.auth!.tenantId,
            actorId: req.auth!.userId,
            proposalType: body.proposalType as SupportedType,
            payload: body.payload,
            summary: body.summary,
            expectedVersion,
          },
          proposalRepo, appointmentRepo, feasibilityDeps,
        );

        switch (result.kind) {
          case 'created': res.status(200).json(result.proposal); return;
          case 'missing_version': res.status(400).json({ error: 'MISSING_VERSION' }); return;
          case 'invalid_version': res.status(400).json({ error: 'INVALID_VERSION' }); return;
          case 'missing_technician': res.status(400).json({ error: 'MISSING_TECHNICIAN', proposalType: result.proposalType }); return;
          case 'not_found': res.status(404).json({ error: 'APPOINTMENT_NOT_FOUND' }); return;
          case 'stale': res.status(409).json({
            error: 'STALE_APPOINTMENT',
            currentVersion: result.currentVersion,
            providedVersion: result.providedVersion,
          }); return;
          case 'infeasible': res.status(422).json({
            error: 'INFEASIBLE',
            ...result.feasibility,
          }); return;
        }
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

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
    '/inbox',
    requireAuth,
    requireTenant,
    requirePermission('proposals:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        // Inbox fetches a capped slice of ready_for_review proposals for the
        // tenant and runs `prioritizeProposals` over them. The 100-item cap
        // keeps the response payload small; if a tenant routinely exceeds
        // it, we'll add pagination — but for a solo operator the inbox is
        // measured in single-digit dozens, not hundreds.
        const all = await proposalRepo.findByStatus(req.auth!.tenantId, 'ready_for_review');
        const inbox = buildInboxPayload(all, 100);
        res.json(inbox);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
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

  // P2-035 — POST /api/proposals/approve-batch. MUST be declared before the
  // `/:id/approve` route so Express does not match "approve-batch" as an :id.
  router.post(
    '/approve-batch',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = validate(approveBatchBodySchema, req.body);
        const result = await approveProposalsBatch(
          proposalRepo,
          req.auth!.tenantId,
          parsed.proposalIds,
          req.auth!.userId,
          req.auth!.role as Role,
          auditRepo,
        );
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
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
          req.auth!.role as Role,
          auditRepo,
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
          appointmentRepo,
          auditRepo,
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
          req.auth!.role as Role,
          auditRepo,
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
          parsed.edits,
          auditRepo,
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
