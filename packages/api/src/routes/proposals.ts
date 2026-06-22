import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { asyncRoute } from '../middleware/async-route';
import { toErrorResponse } from '../shared/errors';
import { validate } from '../shared/validation';
import { Role } from '../auth/rbac';
import { ProposalRepository, isExpiringProposalType, EXPIRING_PROPOSAL_TYPES } from '../proposals/proposal';
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
  reproposeProposal,
  type UndoCorrectionLoopDeps,
} from '../proposals/actions';
import { resolveProposalLine } from '../proposals/resolve-line';
import {
  proposalFilterSchema,
  rejectProposalBodySchema,
  editProposalBodySchema,
} from '../proposals/proposal-contracts';
import { FeasibilityDependencies } from '../scheduling/feasibility-types';
import { createSchedulingProposal } from '../proposals/create-scheduling';
import type { CorrectionRepository } from '../proposals/corrections/correction';

// P2-035 — Batch approval body schema. Lives inline rather than in
// proposal-contracts.ts so this story stays within its allowed-files
// budget. The 50-ID cap bounds blast radius — the inbox UI's "APPROVE
// ALL" affordance is gated client-side on a 3+ threshold, so 50 leaves
// plenty of headroom for the realistic batch sizes without letting a
// scripted caller flood approval audit rows.
const approveBatchBodySchema = z.object({
  proposalIds: z.array(z.string().uuid()).min(1).max(50),
});

// §5.5 — how far back the inbox surfaces expired schedule cards. Operators
// re-propose recent lapses; bounding the window keeps the response from growing
// as expired history accumulates (the cards are still re-proposable via the
// list endpoint by id).
const EXPIRED_INBOX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const EXPIRED_INBOX_LIMIT = 20;

// U2 (P2-035) — resolve an ambiguous catalog line by picking one of the
// line's surfaced candidates. Patches the draft; never approves (D-004).
const resolveLineBodySchema = z.object({
  lineIndex: z.number().int().min(0),
  catalogItemId: z.string().min(1),
});

export function createProposalsRouter(
  proposalRepo: ProposalRepository,
  appointmentRepo?: AppointmentRepository,
  auditRepo?: AuditRepository,
  feasibilityDeps?: FeasibilityDependencies,
  // N-009 / P2-038 — when supplied, undoing a proposal also reverses the
  // structured correction lessons it recorded (and the config each cascaded).
  undoCorrectionLoop?: UndoCorrectionLoopDeps,
  // Story 3.9 — when supplied, editing a proposal logs each changed field
  // (intent + field + before/after) to the corrections training table.
  correctionRepo?: CorrectionRepository,
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
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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
    }),
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('proposals:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const filter = validate(proposalFilterSchema, req.query) as ProposalFilter;
      const result = await listProposals(
        proposalRepo,
        req.auth!.tenantId,
        filter,
        req.auth!.role as Role
      );
      res.json(result);
    })
  );

  router.get(
    '/inbox',
    requireAuth,
    requireTenant,
    requirePermission('proposals:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        // Inbox fetches the open proposals awaiting operator action and
        // runs `prioritizeProposals` over them. Both 'draft' and
        // 'ready_for_review' are surfaced: voice proposals are created in
        // 'draft' (see decideInitialStatus), and chained dependents are
        // forced to 'draft' so they can't auto-execute ahead of a parent —
        // both need to be approvable from the inbox. The 100-item cap keeps
        // the payload small; for a solo operator the inbox is single-digit
        // dozens, not hundreds.
        // §5.5/§10.4 — surface recently-expired schedule + message proposal cards
        // so the operator can see what lapsed and re-propose it. Bounded in the DB
        // (WHERE on type + a recent window, ORDER BY recency, LIMIT) so the inbox
        // can't degrade as expired history accumulates; operators re-propose recent
        // lapses, not ancient ones. Falls back to an in-memory trim for repos that
        // predate the bounded query.
        const since = new Date(Date.now() - EXPIRED_INBOX_WINDOW_MS);
        const [drafts, ready, expiredRows] = await Promise.all([
          proposalRepo.findByStatus(req.auth!.tenantId, 'draft'),
          proposalRepo.findByStatus(req.auth!.tenantId, 'ready_for_review'),
          proposalRepo.findExpiredProposalsByType
            ? proposalRepo.findExpiredProposalsByType(
                req.auth!.tenantId,
                EXPIRING_PROPOSAL_TYPES,
                since,
                EXPIRED_INBOX_LIMIT,
              )
            : proposalRepo.findByStatus(req.auth!.tenantId, 'expired').then((all) =>
                all
                  .filter(
                    (p) =>
                      isExpiringProposalType(p.proposalType) &&
                      (p.expiresAt?.getTime() ?? 0) >= since.getTime(),
                  )
                  .sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))
                  .slice(0, EXPIRED_INBOX_LIMIT),
              ),
        ]);
        const inbox = buildInboxPayload([...ready, ...drafts], 100);
        const expired = expiredRows.map((p) => ({
          id: p.id,
          proposalType: p.proposalType,
          summary: p.summary,
          status: p.status,
          expiresAt: p.expiresAt?.toISOString(),
          createdAt: p.createdAt.toISOString(),
        }));
        res.json({ ...inbox, expired });
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
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await getProposalDetail(
        proposalRepo,
        req.auth!.tenantId,
        req.params.id,
        req.auth!.role as Role
      );
      res.json(result);
    })
  );

  // P2-035 — POST /api/proposals/approve-batch. MUST be declared before the
  // `/:id/approve` route so Express does not match "approve-batch" as an :id.
  router.post(
    '/approve-batch',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = validate(approveBatchBodySchema, req.body);
      const result = await approveProposalsBatch(
        proposalRepo,
        req.auth!.tenantId,
        parsed.proposalIds,
        req.auth!.userId,
        req.auth!.role as Role,
        auditRepo,
        'ui', // RV-073 — batch approvals come from the inbox screen
      );
      res.json(result);
    }),
  );

  router.post(
    '/:id/approve',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await approveProposal(
        proposalRepo,
        req.auth!.tenantId,
        req.params.id,
        req.auth!.userId,
        req.auth!.role as Role,
        auditRepo,
        'ui', // RV-073 — dashboard screen-tap approval
      );
      res.json(result);
    })
  );

  router.post(
    '/:id/resolve-line',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = validate(resolveLineBodySchema, req.body);
      const result = await resolveProposalLine(
        {
          tenantId: req.auth!.tenantId,
          proposalId: req.params.id,
          lineIndex: parsed.lineIndex,
          catalogItemId: parsed.catalogItemId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role as Role,
        },
        { proposalRepo, ...(auditRepo ? { auditRepo } : {}) },
      );
      res.json(result);
    })
  );

  router.post(
    '/:id/reject',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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
        'ui', // RV-073 — dashboard screen-tap rejection
      );
      res.json(result);
    })
  );

  router.post(
    '/:id/undo',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await undoProposal(
        proposalRepo,
        req.auth!.tenantId,
        req.params.id,
        req.auth!.userId,
        req.auth!.role as Role,
        auditRepo,
        undoCorrectionLoop,
      );
      res.json(result);
    })
  );

  // §5.5 — re-propose an expired schedule proposal card. Mints a fresh draft
  // (new 48h clock) carrying the same intent; the expired source is untouched.
  router.post(
    '/:id/re-propose',
    requireAuth,
    requireTenant,
    requirePermission('proposals:approve'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await reproposeProposal(
          proposalRepo,
          req.auth!.tenantId,
          req.params.id,
          req.auth!.userId,
          req.auth!.role as Role,
          auditRepo,
        );
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
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
          correctionRepo,
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
