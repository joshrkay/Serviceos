import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../middleware/async-route';
import { extractIp } from '../shared/extract-ip';
import { PublicEstimateService } from '../estimates/public-estimate-service';

const approveSchema = z.object({
  acceptedByName: z.string().trim().min(2).max(120),
  signatureData: z.string().max(200_000).optional(),
  expectedVersion: z.number().int().positive().optional(),
  selectedLineItemIds: z.array(z.string().min(1)).max(200).optional(),
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

  router.get('/:token', asyncRoute(async (req: Request, res: Response) => {
    const view = await service.getByToken(req.params.token);
    res.json(view);
  }));

  router.post('/:token/view', asyncRoute(async (req: Request, res: Response) => {
    const result = await service.recordView(req.params.token, {
      ip: extractIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.json(result);
  }));

  router.post('/:token/approve', asyncRoute(async (req: Request, res: Response) => {
    const parsed = approveSchema.parse(req.body ?? {});
    const view = await service.approve({
      token: req.params.token,
      acceptedByName: parsed.acceptedByName,
      signatureData: parsed.signatureData,
      expectedVersion: parsed.expectedVersion,
      selectedLineItemIds: parsed.selectedLineItemIds,
      ip: extractIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(200).json(view);
  }));

  router.post('/:token/deposit-checkout', asyncRoute(async (req: Request, res: Response) => {
    const result = await service.getOrCreateDepositCheckoutUrl(req.params.token);
    res.status(200).json(result);
  }));

  router.post('/:token/decline', asyncRoute(async (req: Request, res: Response) => {
    const parsed = declineSchema.parse(req.body ?? {});
    const view = await service.decline({
      token: req.params.token,
      reason: parsed.reason,
      ip: extractIp(req),
      userAgent: req.get('user-agent') ?? undefined,
    });
    res.status(200).json(view);
  }));

  return router;
}

