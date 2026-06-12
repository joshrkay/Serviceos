import { Response, Router } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import type { ChecklistItem, JobChecklistRepository } from '../jobs/checklist';

export function createJobChecklistsRouter(repo: JobChecklistRepository): Router {
  const router = Router();

  router.get(
    '/:jobId/checklists',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const rows = await repo.listByJob(req.auth!.tenantId, req.params.jobId);
        res.json(rows);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/:jobId/checklists',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = req.body as { title?: string; items?: ChecklistItem[] };
        if (!body.title || !Array.isArray(body.items)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'title and items required' });
          return;
        }
        const row = await repo.create({
          tenantId: req.auth!.tenantId,
          jobId: req.params.jobId,
          title: body.title,
          items: body.items,
        });
        res.status(201).json(row);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.patch(
    '/:jobId/checklists/:checklistId',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const items = (req.body as { items?: ChecklistItem[] }).items;
        if (!Array.isArray(items)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'items array required' });
          return;
        }
        const row = await repo.updateItems(req.auth!.tenantId, req.params.checklistId, items);
        if (!row || row.jobId !== req.params.jobId) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Checklist not found' });
          return;
        }
        res.json(row);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
