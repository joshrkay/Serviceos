/**
 * #1406 D3 — the job-detail Parts sheet's persistence.
 *
 * Mount at `/api/jobs` (same shape as job-files / job-photos):
 *   GET /api/jobs/:id/materials  — the job's parts list
 *   PUT /api/jobs/:id/materials  — save the whole sheet (reconcile; see
 *                                  materials/job-materials.ts)
 *
 * Money crosses this boundary as integer cents (`unitCostCents`).
 */
import { Response, Router } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { AuditRepository } from '../audit/audit';
import { JobRepository } from '../jobs/job';
import {
  MATERIAL_CATEGORIES,
  MAX_QUANTITY,
  MaterialItem,
  MaterialItemRepository,
} from '../materials/material-item';
import { listJobMaterials, saveJobMaterials } from '../materials/job-materials';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { asyncRoute } from '../middleware/async-route';
import { notFoundOnMalformedId } from '../middleware/validate-uuid-param';

export interface JobMaterialsRouterDeps {
  materialItemRepo: MaterialItemRepository;
  auditRepo: AuditRepository;
  /** An unknown job id must 404, not write rows against the job_id FK. */
  jobRepo: Pick<JobRepository, 'findById'>;
}

const saveSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().max(100).optional(),
        name: z.string().trim().min(1).max(500),
        partNumber: z.string().trim().max(100).optional(),
        quantity: z.number().int().positive().max(MAX_QUANTITY),
        unitCostCents: z.number().int().nonnegative().max(100_000_000).optional(),
        category: z.enum(MATERIAL_CATEGORIES).optional(),
      }),
    )
    .max(200),
});

function toResponse(item: MaterialItem) {
  return {
    id: item.id,
    name: item.description,
    ...(item.partNumber !== undefined ? { partNumber: item.partNumber } : {}),
    quantity: item.quantity,
    ...(item.unitCostCents !== undefined ? { unitCostCents: item.unitCostCents } : {}),
    ...(item.category !== undefined ? { category: item.category } : {}),
    status: item.status,
  };
}

export function createJobMaterialsRouter(deps: JobMaterialsRouterDeps): Router {
  const router = Router();

  router.get(
    '/:id/materials',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    notFoundOnMalformedId('Job not found'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const job = await deps.jobRepo.findById(tenantId, req.params.id);
      if (!job) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
        return;
      }
      const items = await listJobMaterials(tenantId, req.params.id, deps);
      res.json({ data: items.map(toResponse) });
    }),
  );

  router.put(
    '/:id/materials',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    notFoundOnMalformedId('Job not found'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const parsed = saveSchema.parse(req.body ?? {});
      const job = await deps.jobRepo.findById(tenantId, req.params.id);
      if (!job) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
        return;
      }
      const items = await saveJobMaterials(
        { tenantId, actorId: req.auth!.userId, actorRole: req.auth!.role },
        req.params.id,
        parsed.items,
        deps,
      );
      res.json({ data: items.map(toResponse) });
    }),
  );

  return router;
}
