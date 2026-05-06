/**
 * P9-003 — Service agreements REST router.
 */
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import {
  requireAuth,
  requireTenant,
  requirePermission,
  requireRole,
} from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { AgreementRepository } from '../agreements/agreement';
import { AgreementRunRepository } from '../agreements/agreement-run';
import {
  createAgreement,
  updateAgreement,
  pauseAgreement,
  resumeAgreement,
  cancelAgreement,
  runDueAgreements,
  JobsServicePort,
  InvoicesServicePort,
} from '../agreements/agreement-service';
import {
  createAgreementSchema,
  updateAgreementSchema,
} from '../agreements/enums';
import { AuditRepository } from '../audit/audit';

export interface AgreementsRouterDeps {
  agreementRepo: AgreementRepository;
  runRepo: AgreementRunRepository;
  auditRepo: AuditRepository;
  jobsService: JobsServicePort;
  invoicesService: InvoicesServicePort;
}

export function createAgreementsRouter(deps: AgreementsRouterDeps): Router {
  const router = Router();
  const { agreementRepo, runRepo, auditRepo, jobsService, invoicesService } = deps;

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createAgreementSchema.parse(req.body);
        const result = await createAgreement(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            createdBy: req.auth!.userId,
            actorRole: req.auth!.role,
          },
          agreementRepo,
          auditRepo,
        );
        res.status(201).json(result);
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
    requirePermission('customers:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const customerId = req.query.customerId as string | undefined;
        const status = req.query.status as
          | 'active'
          | 'paused'
          | 'cancelled'
          | undefined;
        const data = await agreementRepo.findByTenant(req.auth!.tenantId, {
          customerId,
          status,
        });
        res.json({ data, total: data.length });
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
    requirePermission('customers:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const agreement = await agreementRepo.findById(tenantId, req.params.id);
        if (!agreement) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Agreement not found' });
          return;
        }
        const runs = await runRepo.findByAgreement(tenantId, agreement.id, 25);
        res.json({ ...agreement, recentRuns: runs });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.patch(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = updateAgreementSchema.parse(req.body);
        const result = await updateAgreement(
          req.auth!.tenantId,
          req.params.id,
          parsed,
          agreementRepo,
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Agreement not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/:id/pause',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await pauseAgreement(req.auth!.tenantId, req.params.id, agreementRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Agreement not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/:id/resume',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await resumeAgreement(req.auth!.tenantId, req.params.id, agreementRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Agreement not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/:id/cancel',
    requireAuth,
    requireTenant,
    requirePermission('customers:delete'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await cancelAgreement(req.auth!.tenantId, req.params.id, agreementRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Agreement not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  // Owner-only manual trigger. Useful for support runbooks ("the recurring
  // run for tenant X failed last night — re-run it now").
  router.post(
    '/:id/run-now',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const agreement = await agreementRepo.findById(tenantId, req.params.id);
        if (!agreement) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Agreement not found' });
          return;
        }
        // Force the next-run pointer to "now" for this single agreement so
        // the sweep picks it up, then run.
        const now = new Date();
        if (agreement.nextRunAt.getTime() > now.getTime()) {
          await agreementRepo.update(tenantId, agreement.id, { nextRunAt: now });
        }
        const result = await runDueAgreements(tenantId, {
          agreementRepo,
          runRepo,
          jobsService,
          invoicesService,
          auditRepo,
          now,
        });
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
