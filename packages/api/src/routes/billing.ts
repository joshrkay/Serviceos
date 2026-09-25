import { Router, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { resolveOwnerEmail } from '../auth/resolve-owner-email';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse, NotFoundError } from '../shared/errors';
import { BillingService } from '../billing/subscription';
import { StripeConnectService } from '../billing/stripe-connect';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { AiUsageReader } from '../billing/ai-usage';
import type { PgOverageCapStore } from '../billing/overage-cap';

/**
 * Tier 4 (Subscription — Rivet billing). Endpoints for the SaaS
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
  /** Optional audit repository for emitting billing lifecycle events. */
  auditRepo?: AuditRepository;
  /** Used to resolve owner email when the JWT has no email claim. */
  pool?: Pool;
  /** AI-minute usage summary for the settings page. */
  aiUsage?: Pick<AiUsageReader, 'getUsage'>;
  /** Owner-set AI-minute overage cap. */
  overageCaps?: Pick<PgOverageCapStore, 'set'>;
}

export function createBillingRouter(deps: BillingRouteDeps = {}): Router {
  const { billingService, connectService, auditRepo, pool } = deps;
  const router = Router();

  router.get(
    '/ai-usage',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.aiUsage) {
          res.status(503).json({
            error: 'BILLING_NOT_CONFIGURED',
            message: 'AI minute usage is not configured',
          });
          return;
        }
        res.json(await deps.aiUsage.getUsage(req.auth!.tenantId));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  // Owner-only: how much AI-minute overage may be charged per period
  // before calls forward to the owner. null removes the cap.
  const overageCapSchema = z.object({
    capCents: z.number().int().nonnegative().max(10_000_000).nullable(),
  });
  router.put(
    '/ai-overage-cap',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.overageCaps) {
          res.status(503).json({
            error: 'BILLING_NOT_CONFIGURED',
            message: 'AI minute overage cap is not configured',
          });
          return;
        }
        const { capCents } = overageCapSchema.parse(req.body ?? {});
        await deps.overageCaps.set(req.auth!.tenantId, capCents);
        if (auditRepo) {
          await auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'ai_overage_cap_updated',
              entityType: 'tenant_settings',
              entityId: req.auth!.tenantId,
              metadata: { capCents },
            }),
          );
        }
        res.json({ capCents });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/subscription',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!billingService) {
          // Legacy harness without the service wired — return null
          // fields so the UI surfaces "not configured" rather than
          // a hard error.
          res.json({ customerId: null, subscriptionId: null, status: null });
          return;
        }
        const view = await billingService.getSubscription(req.auth!.tenantId);
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
        if (!billingService) {
          res.status(503).json({
            error: 'BILLING_NOT_CONFIGURED',
            message: 'Subscription billing is not configured',
          });
          return;
        }
        const parsed = portalSessionSchema.parse(req.body ?? {});
        // Prefer JWT/clerkUser email; fall back to users/tenants rows
        // (serviceos template historically omitted email).
        const email = await resolveOwnerEmail(req, pool);
        if (!email) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Owner email not present on auth context',
          });
          return;
        }
        const result = await billingService!.getOrCreatePortalUrl({
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
        if (!connectService) {
          res.json({ accountId: null, status: 'pending', chargesEnabled: false, payoutsEnabled: false });
          return;
        }
        const view = await connectService.getAccount(req.auth!.tenantId);
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
        if (!connectService) {
          res.status(503).json({
            error: 'CONNECT_NOT_CONFIGURED',
            message: 'Stripe Connect is not configured',
          });
          return;
        }
        const parsed = connectOnboardingSchema.parse(req.body ?? {});
        const email = await resolveOwnerEmail(req, pool);
        if (!email) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Owner email not present on auth context',
          });
          return;
        }
        const result = await connectService!.createOnboardingLink({
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
        if (!connectService) {
          res.status(503).json({
            error: 'CONNECT_NOT_CONFIGURED',
            message: 'Stripe Connect is not configured',
          });
          return;
        }
        const ok = await connectService!.disconnect(req.auth!.tenantId);
        res.json({ disconnected: ok });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * POST /api/billing/end-trial-now
   *
   * Ends the tenant's Stripe trial subscription immediately. Used by
   * the upgrade-nudge banner when the operator opts in early. Requires
   * billingService (503 when Stripe is not configured) and an active
   * subscription on the tenant row (409 NO_SUBSCRIPTION otherwise).
   * Emits a tenant.trial_ended_early audit event.
   */
  router.post(
    '/end-trial-now',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!billingService) {
          res.status(503).json({
            error: 'BILLING_NOT_CONFIGURED',
            message: 'Subscription billing is not configured',
          });
          return;
        }

        const tenantId = req.auth!.tenantId;
        const userId = req.auth!.userId;

        // endTrialNow throws NotFoundError('Subscription', ...) when no
        // stripe_subscription_id is on file — translate to 409 NO_SUBSCRIPTION.
        try {
          await billingService.endTrialNow(tenantId);
        } catch (innerErr: unknown) {
          if (
            innerErr instanceof NotFoundError &&
            innerErr.message.startsWith('Subscription not found')
          ) {
            res.status(409).json({ error: 'NO_SUBSCRIPTION' });
            return;
          }
          throw innerErr;
        }

        if (auditRepo) {
          await auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: userId,
              actorRole: req.auth!.role,
              eventType: 'tenant.trial_ended_early',
              entityType: 'tenant',
              entityId: tenantId,
              metadata: {},
            }),
          );
        }

        res.json({ ok: true });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
