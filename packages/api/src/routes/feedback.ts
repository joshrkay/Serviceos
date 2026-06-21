import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { FeedbackResponseRepository } from '../feedback/feedback-response';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function createFeedbackResponsesRouter(responseRepo: FeedbackResponseRepository): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const { limit, offset } = listQuerySchema.parse(req.query);
      const { responses, total } = await responseRepo.listByTenant(req.auth!.tenantId, { limit, offset });
      res.json({ responses, total });
    })
  );

  return router;
}
