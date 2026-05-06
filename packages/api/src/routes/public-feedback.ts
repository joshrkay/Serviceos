import { Request, Router, Response } from 'express';
import { z } from 'zod';
import { toErrorResponse } from '../shared/errors';
import { FeedbackRequestRepository } from '../feedback/feedback-request';
import { createFeedbackResponse, FeedbackResponseRepository } from '../feedback/feedback-response';
import { SettingsRepository } from '../settings/settings';

const submitSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).nullable().optional(),
});

export function createPublicFeedbackRouter(
  requestRepo: FeedbackRequestRepository,
  responseRepo: FeedbackResponseRepository,
  settingsRepo: SettingsRepository
): Router {
  const router = Router();

  router.get('/:token', async (req: Request, res: Response) => {
    try {
      const request = await requestRepo.findByToken(req.params.token);
      if (!request) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Feedback request not found' });
        return;
      }

      const existing = await responseRepo.findByRequest(request.tenantId, request.id);
      if (existing) {
        res.json({ status: 'submitted', jobId: request.jobId });
        return;
      }

      if (request.expiresAt.getTime() < Date.now()) {
        res.json({ status: 'expired', jobId: request.jobId });
        return;
      }

      const settings = await settingsRepo.findByTenant(request.tenantId);
      res.json({
        status: 'pending',
        jobId: request.jobId,
        businessName: settings?.businessName,
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/:token', async (req: Request, res: Response) => {
    try {
      const request = await requestRepo.findByToken(req.params.token);
      if (!request) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Feedback request not found' });
        return;
      }

      const parsed = submitSchema.parse(req.body ?? {});

      const existing = await responseRepo.findByRequest(request.tenantId, request.id);
      if (existing) {
        res.status(409).json({ error: 'CONFLICT', message: 'Feedback already submitted' });
        return;
      }

      if (request.expiresAt.getTime() < Date.now()) {
        res.status(410).json({ error: 'GONE', message: 'Feedback request expired' });
        return;
      }

      const response = createFeedbackResponse({
        tenantId: request.tenantId,
        requestId: request.id,
        jobId: request.jobId,
        rating: parsed.rating,
        comment: parsed.comment ?? null,
      });

      await responseRepo.create(response);
      await requestRepo.markSubmitted(request.tenantId, request.id);
      res.status(201).json({ ok: true });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}
