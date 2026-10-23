import { Router, Request, Response } from 'express';
import { isValidTenantId } from '../db/schema';
import { createLogger } from '../logging/logger';
import { routeParam } from '../shared/route-params';
import { handleLsaLeadEvent, type LsaWebhookDeps } from './lsa-webhook';

const logger = createLogger({ service: 'lsa-webhook', environment: process.env.NODE_ENV || 'development' });

/**
 * `POST /webhooks/lsa/:tenantId` — mounted with `express.raw()` in app.ts so
 * the HMAC sees the exact delivered bytes (same treatment as Vapi/Stripe).
 */
export function createLsaWebhookRouter(deps: LsaWebhookDeps): Router {
  const router = Router();
  router.post('/lsa/:tenantId', async (req: Request, res: Response) => {
    const tenantId = routeParam(req, 'tenantId');
    if (!isValidTenantId(tenantId)) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : JSON.stringify(req.body ?? {});
    try {
      const result = await handleLsaLeadEvent(deps, {
        tenantId,
        rawBody,
        signatureHeader: req.header('x-lsa-signature') ?? null,
      });
      return res.status(result.status).json(result.body);
    } catch (err) {
      logger.error('LSA webhook handler error', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      // 500 => the sender retries; the receipt stays unprocessed so it reprocesses.
      return res.status(500).json({ error: 'LSA_WEBHOOK_FAILED' });
    }
  });
  return router;
}
