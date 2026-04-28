import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { FeedbackResponseRepository } from '../feedback/feedback-response';
import { toErrorResponse } from '../shared/errors';

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
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { limit, offset } = listQuerySchema.parse(req.query);
        const { responses, total } = await responseRepo.listByTenant(req.auth!.tenantId, { limit, offset });
        res.json({ responses, total });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
