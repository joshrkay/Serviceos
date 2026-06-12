import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../../middleware/auth';

/**
 * P15-001 — QuickBooks OAuth connect (v1 stub: returns configured redirect).
 */
export function createQboRouter(): Router {
  const router = Router();

  router.get(
    '/connect',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const clientId = process.env.QBO_CLIENT_ID;
      if (!clientId) {
        res.status(503).json({ error: 'QBO_NOT_CONFIGURED' });
        return;
      }
      const redirectUri = process.env.QBO_REDIRECT_URI ?? `${process.env.APP_PUBLIC_URL}/api/integrations/qbo/callback`;
      const state = Buffer.from(JSON.stringify({ tenantId })).toString('base64url');
      const url =
        `https://appcenter.intuit.com/connect/oauth2?client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code&scope=com.intuit.quickbooks.accounting&state=${state}`;
      res.json({ authorizationUrl: url });
    },
  );

  return router;
}
