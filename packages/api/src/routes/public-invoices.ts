import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PublicInvoiceService } from '../invoices/public-invoice-service';
import { toErrorResponse } from '../shared/errors';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'public-invoices',
  environment: process.env.NODE_ENV || 'dev',
});

// Mirror the bounds the service layer enforces (public-invoice-service.ts) so a
// malformed token is rejected at the route layer too, with a logged reason.
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;

const tokenGuard = (token: string | undefined, res: Response): boolean => {
  if (!token || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    const reason = !token
      ? 'missing'
      : token.length < MIN_TOKEN_LENGTH
        ? 'too_short'
        : 'too_long';
    logger.warn('Public invoice token rejected', { reason, length: token?.length ?? 0 });
    res.status(400).json({ error: 'INVALID_TOKEN', message: 'Invalid token' });
    return false;
  }
  return true;
};

// Log the failure (5xx → error, expected 4xx → warn) before responding, so
// route-layer errors aren't silent. The view token is capability-sensitive and
// is never logged.
function respondError(res: Response, err: unknown, op: string): void {
  const { statusCode, body } = toErrorResponse(err);
  const meta = { op, statusCode, error: err instanceof Error ? err.message : String(err) };
  if (statusCode >= 500) logger.error('Public invoice request failed', meta);
  else logger.warn('Public invoice request failed', meta);
  res.status(statusCode).json(body);
}

export function createPublicInvoicesRouter(service: PublicInvoiceService): Router {
  const router = Router();

  /**
   * GET /public/invoices/:token
   * Returns the public invoice view for the given view token.
   */
  router.get('/:token', async (req: Request, res: Response) => {
    if (!tokenGuard(req.params.token, res)) return;
    try {
      const view = await service.getByToken(req.params.token);
      res.json(view);
    } catch (err) {
      respondError(res, err, 'getByToken');
    }
  });

  /**
   * POST /public/invoices/:token/view
   * Records a page view (increments viewCount, sets firstViewedAt).
   */
  router.post('/:token/view', async (req: Request, res: Response) => {
    if (!tokenGuard(req.params.token, res)) return;
    try {
      const result = await service.recordView(req.params.token);
      res.json(result);
    } catch (err) {
      respondError(res, err, 'recordView');
    }
  });

  /**
   * POST /public/invoices/:token/checkout
   * Returns a Stripe-hosted checkout URL for this invoice. Creates the Stripe
   * Payment Link on first call and caches it on the invoice row for subsequent
   * calls (idempotent).
   */
  const checkoutSchema = z.object({}).passthrough();

  router.post('/:token/checkout', async (req: Request, res: Response) => {
    if (!tokenGuard(req.params.token, res)) return;
    try {
      checkoutSchema.parse(req.body);
      const result = await service.getOrCreateCheckoutUrl(req.params.token);
      res.json(result);
    } catch (err) {
      respondError(res, err, 'getOrCreateCheckoutUrl');
    }
  });

  return router;
}
