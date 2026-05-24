import { Request, Router, Response } from 'express';
import { z } from 'zod';
import { toErrorResponse } from '../shared/errors';
import { extractIp } from '../shared/extract-ip';
import { FeedbackRequestRepository } from '../feedback/feedback-request';
import {
  createFeedbackResponse,
  FeedbackResponseRepository,
  publicActorFromToken,
} from '../feedback/feedback-response';
import { SettingsRepository } from '../settings/settings';
import { AuditRepository, createAuditEvent } from '../audit/audit';

const submitSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).nullable().optional(),
});

export function createPublicFeedbackRouter(
  requestRepo: FeedbackRequestRepository,
  responseRepo: FeedbackResponseRepository,
  settingsRepo: SettingsRepository,
  /**
   * D2-1d — audit logging for the public feedback submission. Optional
   * so harnesses that don't wire it (older route tests) still build.
   */
  auditRepo?: AuditRepository,
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

      if (auditRepo) {
        // D2-1d — token-scoped public actor; we never persist the raw
        // token, just a 12-char SHA-256 prefix so the audit row can be
        // correlated to the originating link.
        await auditRepo.create(
          createAuditEvent({
            tenantId: request.tenantId,
            actorId: publicActorFromToken(req.params.token),
            actorRole: 'customer',
            eventType: 'feedback_response.submitted',
            entityType: 'feedback_response',
            entityId: response.id,
            metadata: {
              requestId: request.id,
              jobId: request.jobId,
              rating: response.rating,
              hasComment: Boolean(response.comment),
              ipAddress: extractIp(req),
              userAgent: req.headers['user-agent'],
            },
          }),
        );
      }

      // Surface the tenant's public review links only to satisfied
      // customers (4★+), mirroring the Settings copy ("Customers with a
      // 4+ rating will see a button linking here"). Empty/unset links are
      // omitted so the feedback page renders no button.
      let reviewUrls: { google?: string; yelp?: string } | undefined;
      if (parsed.rating >= 4) {
        const settings = await settingsRepo.findByTenant(request.tenantId);
        const google = settings?.googleReviewUrl?.trim();
        const yelp = settings?.yelpReviewUrl?.trim();
        if (google || yelp) {
          reviewUrls = {};
          if (google) reviewUrls.google = google;
          if (yelp) reviewUrls.yelp = yelp;
        }
      }

      res.status(201).json({ ok: true, ...(reviewUrls ? { reviewUrls } : {}) });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}
