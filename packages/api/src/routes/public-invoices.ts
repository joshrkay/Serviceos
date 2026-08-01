import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PublicInvoiceService } from '../invoices/public-invoice-service';
import { asyncRoute } from '../middleware/async-route';

const MIN_TOKEN_LENGTH = 16;

const tokenGuard = (token: string | undefined, res: Response): boolean => {
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    res.status(400).json({ error: 'INVALID_TOKEN', message: 'Token too short' });
    return false;
  }
  return true;
};

export function createPublicInvoicesRouter(service: PublicInvoiceService): Router {
  const router = Router();

  /**
   * GET /public/invoices/:token
   * Returns the public invoice view for the given view token.
   */
  router.get('/:token', asyncRoute(async (req: Request, res: Response) => {
    if (!tokenGuard(req.params.token, res)) return;
    const view = await service.getByToken(req.params.token);
    res.json(view);
  }));

  /**
   * POST /public/invoices/:token/view
   * Records a page view (increments viewCount, sets firstViewedAt).
   */
  router.post('/:token/view', asyncRoute(async (req: Request, res: Response) => {
    if (!tokenGuard(req.params.token, res)) return;
    const result = await service.recordView(req.params.token);
    res.json(result);
  }));

  /**
   * POST /public/invoices/:token/checkout
   * Returns a Stripe-hosted checkout URL for this invoice. Creates the Stripe
   * Payment Link on first call and caches it on the invoice row for subsequent
   * calls (idempotent).
   */
  const checkoutSchema = z.object({}).passthrough();

  router.post('/:token/checkout', asyncRoute(async (req: Request, res: Response) => {
    if (!tokenGuard(req.params.token, res)) return;
    checkoutSchema.parse(req.body);
    const result = await service.getOrCreateCheckoutUrl(req.params.token);
    res.json(result);
  }));

  return router;
}
