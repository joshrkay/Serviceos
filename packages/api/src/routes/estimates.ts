import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createEstimateSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
import { TenantOwnership } from '../shared/tenant-ownership';
import {
  createEstimate,
  listEstimates,
  getEstimate,
  updateEstimate,
  transitionEstimateStatus,
  EstimateRepository,
} from '../estimates/estimate';
import { AuditRepository } from '../audit/audit';
import { getNextEstimateNumber, SettingsRepository } from '../settings/settings';

export function createEstimateRouter(
  estimateRepo: EstimateRepository,
  settingsRepo: SettingsRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership
): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createEstimateSchema.parse(req.body);
        // Cross-entity tenant guard: jobId must belong to the requesting tenant.
        await ownership.requireExists(req.auth!.tenantId, 'job', parsed.jobId);
        const estimateNumber = await getNextEstimateNumber(req.auth!.tenantId, settingsRepo);
        const result = await createEstimate(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            estimateNumber,
            validUntil: parsed.validUntil ? new Date(parsed.validUntil) : undefined,
            createdBy: req.auth!.userId,
          },
          estimateRepo,
          auditRepo
        );
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
        const result = jobId
          ? await estimateRepo.findByJob(req.auth!.tenantId, jobId)
          : await listEstimates(req.auth!.tenantId, estimateRepo);
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
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getEstimate(req.auth!.tenantId, req.params.id, estimateRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  const updateHandler = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await updateEstimate(req.auth!.tenantId, req.params.id, req.body, estimateRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  };

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:update'),
    updateHandler
  );

  router.patch(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:update'),
    updateHandler
  );

  router.post(
    '/:id/transition',
    requireAuth,
    requireTenant,
    requirePermission('estimates:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { status } = req.body;
        if (!status) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'status is required' });
          return;
        }
        const result = await transitionEstimateStatus(req.auth!.tenantId, req.params.id, status, estimateRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
