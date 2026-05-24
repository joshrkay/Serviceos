import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { toErrorResponse } from '../shared/errors';
import { extractIp } from '../shared/extract-ip';
import { PublicEstimateService } from '../estimates/public-estimate-service';

const approveSchema = z.object({
  acceptedByName: z.string().trim().min(2).max(120),
  signatureData: z.string().max(200_000).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

const declineSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
});

/**
 * Unauthenticated customer-facing routes for estimate approval.
 * Mounted at `/public/estimates`. Auth is the view-token in the URL —
 * no Clerk JWT, no tenant header. Tenant scoping is enforced by the
 * service layer's token-based lookup.
 *
 * IP and user-agent are captured for non-repudiation on accept/decline.
 */
export function createPublicEstimatesRouter(
  service: PublicEstimateService
): Router {
  const router = Router();

  router.get('/:token', async (req: Request, res: Response) => {
    try {
      const view = await service.getByToken(req.params.token);
      res.json(view);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/:token/view', async (req: Request, res: Response) => {
    try {
      const result = await service.recordView(req.params.token, {
        ip: extractIp(req),
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.json(result);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/:token/approve', async (req: Request, res: Response) => {
    try {
      const parsed = approveSchema.parse(req.body ?? {});
      const view = await service.approve({
        token: req.params.token,
        acceptedByName: parsed.acceptedByName,
        signatureData: parsed.signatureData,
        expectedVersion: parsed.expectedVersion,
        ip: extractIp(req),
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json(view);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/:token/deposit-checkout', async (req: Request, res: Response) => {
    try {
      const result = await service.getOrCreateDepositCheckoutUrl(req.params.token);
      res.status(200).json(result);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/:token/decline', async (req: Request, res: Response) => {
    try {
      const parsed = declineSchema.parse(req.body ?? {});
      const view = await service.decline({
        token: req.params.token,
        reason: parsed.reason,
        ip: extractIp(req),
        userAgent: req.get('user-agent') ?? undefined,
      });
      res.status(200).json(view);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

