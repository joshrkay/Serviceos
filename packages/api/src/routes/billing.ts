import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { BillingService } from '../billing/subscription';

/**
 * Tier 4 (Subscription — Fieldly billing). Endpoints for the SaaS
 * subscription Settings sheet:
 *
 *   POST /api/billing/portal-session — mints a Stripe Customer Portal
 *     URL the operator can be redirected to. Owner-only because the
 *     portal exposes payment methods + cancellation.
 *
 *   GET /api/billing/subscription — returns the cached subscription
 *     view (customer id, subscription id, status). settings:view
 *     gates this so dispatchers can also see the status.
 *
 * The Stripe webhook route handles customer.subscription.* events and
 * keeps the cached status fresh.
 */
const portalSessionSchema = z.object({
  /** Where Stripe redirects after the operator closes the portal. */
  returnUrl: z.string().url().max(2048),
});

export interface BillingRouteDeps {
  billingService?: BillingService;
}

export function createBillingRouter(deps: BillingRouteDeps = {}): Router {
  const router = Router();

  router.get(
    '/subscription',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.billingService) {
          // Legacy harness without the service wired — return null
          // fields so the UI surfaces "not configured" rather than
          // a hard error.
          res.json({ customerId: null, subscriptionId: null, status: null });
          return;
        }
        const view = await deps.billingService.getSubscription(req.auth!.tenantId);
        res.json(view);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/portal-session',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.billingService) {
          res.status(503).json({
            error: 'BILLING_NOT_CONFIGURED',
            message: 'Subscription billing is not configured',
          });
          return;
        }
        const parsed = portalSessionSchema.parse(req.body ?? {});
        // Owner email is populated on req.clerkUser by the auth
        // middleware after JWT verification (see auth/clerk.ts —
        // ClerkUser carries email/firstName/lastName separately
        // from the auth context to keep the auth shape minimal).
        const email = req.clerkUser?.email;
        if (!email) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Owner email not present on auth context',
          });
          return;
        }
        const result = await deps.billingService.getOrCreatePortalUrl({
          tenantId: req.auth!.tenantId,
          ownerEmail: email,
          returnUrl: parsed.returnUrl,
        });
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
