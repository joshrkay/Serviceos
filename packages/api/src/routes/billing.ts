import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { BillingService } from '../billing/subscription';
import { StripeConnectService } from '../billing/stripe-connect';

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

const connectOnboardingSchema = z.object({
  returnUrl: z.string().url().max(2048),
  refreshUrl: z.string().url().max(2048),
  country: z.string().length(2).optional(),
});

export interface BillingRouteDeps {
  billingService?: BillingService;
  /** Tier 4 (Payment methods — PR 1). Stripe Connect onboarding +
   *  status. Optional so legacy harnesses without Connect configured
   *  still build the router. */
  connectService?: StripeConnectService;
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

  /**
   * Tier 4 (Payment methods — PR 1). Returns the tenant's Connect
   * account view. settings:view gates this so dispatchers can check
   * whether payment processing is set up before they prompt customers.
   */
  router.get(
    '/connect',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.connectService) {
          res.json({ accountId: null, status: 'pending', chargesEnabled: false, payoutsEnabled: false });
          return;
        }
        const view = await deps.connectService.getAccount(req.auth!.tenantId);
        res.json(view);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * Mints (or creates + mints on first call) the Stripe-hosted
   * onboarding URL. Owner-only — onboarding shares bank details +
   * EIN. Stripe issues short-lived links so we don't cache them.
   */
  router.post(
    '/connect/onboarding',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.connectService) {
          res.status(503).json({
            error: 'CONNECT_NOT_CONFIGURED',
            message: 'Stripe Connect is not configured',
          });
          return;
        }
        const parsed = connectOnboardingSchema.parse(req.body ?? {});
        const email = req.clerkUser?.email;
        if (!email) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Owner email not present on auth context',
          });
          return;
        }
        const result = await deps.connectService.createOnboardingLink({
          tenantId: req.auth!.tenantId,
          ownerEmail: email,
          returnUrl: parsed.returnUrl,
          refreshUrl: parsed.refreshUrl,
          country: parsed.country,
        });
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * Soft disconnect — flips status to 'disconnected' but keeps the
   * Stripe Account on file. Stripe doesn't expose a delete-account
   * API for Connect; future reconnect re-enables charges/payouts via
   * webhook once the operator completes onboarding again.
   */
  router.delete(
    '/connect',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.connectService) {
          res.status(503).json({
            error: 'CONNECT_NOT_CONFIGURED',
            message: 'Stripe Connect is not configured',
          });
          return;
        }
        const ok = await deps.connectService.disconnect(req.auth!.tenantId);
        res.json({ disconnected: ok });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
