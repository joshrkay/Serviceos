import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { AuditRepository } from '../audit/audit';
import { CustomerRepository } from '../customers/customer';
import {
  DEFAULT_LIST_LIMIT,
  LeadListOptions,
  LeadRepository,
  MAX_LIST_LIMIT,
} from '../leads/lead';
import {
  createLead,
  updateLead,
  convertToCustomer,
  loseLead,
} from '../leads/lead-service';
import {
  createLeadSchema,
  loseLeadSchema,
  updateLeadSchema,
  LEAD_SOURCES,
  LEAD_STAGES,
  LeadSource,
  LeadStage,
} from '../leads/enums';

export function createLeadsRouter(
  leadRepo: LeadRepository,
  customerRepo: CustomerRepository,
  auditRepo: AuditRepository
): Router {
  const router = Router();

  // Reuse customer-scoped permissions: leads are CRM-adjacent and the
  // permission enum is Tier-1 frozen for this wave.
  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createLeadSchema.parse(req.body);
        const lead = await createLead(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            createdBy: req.auth!.userId,
            actorRole: req.auth!.role,
          },
          leadRepo,
          auditRepo
        );
        res.status(201).json(lead);
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
    requirePermission('customers:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const stageRaw = req.query.stage as string | undefined;
        const sourceRaw = req.query.source as string | undefined;
        const assignedRaw = req.query.assignedUserId as string | undefined;

        if (stageRaw && !(LEAD_STAGES as readonly string[]).includes(stageRaw)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: `Invalid stage: ${stageRaw}` });
          return;
        }
        if (sourceRaw && !(LEAD_SOURCES as readonly string[]).includes(sourceRaw)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: `Invalid source: ${sourceRaw}` });
          return;
        }

        const limitRaw = req.query.limit as string | undefined;
        const offsetRaw = req.query.offset as string | undefined;
        const limit =
          limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_LIST_LIMIT;
        const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;
        if (
          limitRaw !== undefined &&
          (Number.isNaN(limit) || limit < 1 || limit > MAX_LIST_LIMIT)
        ) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `limit must be between 1 and ${MAX_LIST_LIMIT}`,
          });
          return;
        }
        if (offsetRaw !== undefined && (Number.isNaN(offset) || offset < 0)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'offset must be a non-negative integer',
          });
          return;
        }

        const options: LeadListOptions = {
          stage: stageRaw as LeadStage | undefined,
          source: sourceRaw as LeadSource | undefined,
          assignedUserId: assignedRaw,
          limit: Math.min(limit, MAX_LIST_LIMIT),
          offset,
        };
        const result = await leadRepo.listWithMeta(req.auth!.tenantId, options);
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
    requirePermission('customers:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const lead = await leadRepo.findById(req.auth!.tenantId, req.params.id);
        if (!lead) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Lead not found' });
          return;
        }
        res.json(lead);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.patch(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = updateLeadSchema.parse(req.body);
        const updated = await updateLead(
          req.auth!.tenantId,
          req.params.id,
          parsed,
          leadRepo,
          req.auth!.userId,
          req.auth!.role,
          auditRepo
        );
        if (!updated) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Lead not found' });
          return;
        }
        res.json(updated);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/convert',
    requireAuth,
    requireTenant,
    requirePermission('customers:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await convertToCustomer(
          req.auth!.tenantId,
          req.params.id,
          leadRepo,
          customerRepo,
          req.auth!.userId,
          req.auth!.role,
          auditRepo
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Lead not found' });
          return;
        }
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/lose',
    requireAuth,
    requireTenant,
    requirePermission('customers:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = loseLeadSchema.parse(req.body);
        const updated = await loseLead(
          req.auth!.tenantId,
          req.params.id,
          parsed.reason,
          leadRepo,
          req.auth!.userId,
          req.auth!.role,
          auditRepo
        );
        if (!updated) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Lead not found' });
          return;
        }
        res.json(updated);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
