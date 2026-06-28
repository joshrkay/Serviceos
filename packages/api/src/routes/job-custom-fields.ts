import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import {
  JobCustomFieldRepository,
  createJobCustomFieldDef,
  listResolvedJobCustomFields,
  setJobCustomFieldValue,
} from '../jobs/job-custom-field';
import { createCustomFieldDefSchema, setCustomFieldValueSchema } from '../shared/contracts';

/**
 * J-CF (Jobber parity) — job custom fields.
 *
 * Mounted at /api/job-custom-fields. Definition management is a settings-level
 * operation (`settings:update`); reading defs + reading/writing per-job values
 * is field work (`jobs:view` / `jobs:update`). Reuses the generic custom-field
 * contracts shared with the customer twin.
 */
export function createJobCustomFieldRouter(
  repo: JobCustomFieldRepository,
  auditRepo: AuditRepository
): Router {
  const router = Router();

  router.get(
    '/defs',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const includeArchived = req.query.includeArchived === 'true';
      res.json(await repo.listDefs(req.auth!.tenantId, includeArchived));
    })
  );

  router.post(
    '/defs',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createCustomFieldDefSchema.parse(req.body);
      const def = await createJobCustomFieldDef(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        repo,
        auditRepo
      );
      res.status(201).json(def);
    })
  );

  router.post(
    '/defs/:fieldDefId/archive',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const archived = await repo.archiveDef(req.auth!.tenantId, req.params.fieldDefId);
      if (!archived) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job custom field not found' });
        return;
      }
      res.json(archived);
    })
  );

  router.get(
    '/jobs/:jobId',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      res.json(await listResolvedJobCustomFields(req.auth!.tenantId, req.params.jobId, repo));
    })
  );

  router.put(
    '/jobs/:jobId/values/:fieldDefId',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = setCustomFieldValueSchema.parse(req.body);
      await setJobCustomFieldValue(
        req.auth!.tenantId,
        req.params.jobId,
        req.params.fieldDefId,
        parsed.value,
        repo,
        req.auth!.userId,
        auditRepo
      );
      res.json(await listResolvedJobCustomFields(req.auth!.tenantId, req.params.jobId, repo));
    })
  );

  return router;
}
