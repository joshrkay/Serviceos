import { Router, Response } from 'express';
import type { Pool } from 'pg';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { SettingsRepository, TenantSettings } from '../settings/settings';
import { PackActivationRepository, activatePack } from '../settings/pack-activation';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { v4 as uuidv4 } from 'uuid';
import { loadOnboardingFacts } from '../onboarding/load-facts';
import { deriveOnboardingStatus } from '../onboarding/derive-status';
import { BusinessIdentityInputSchema, PackPickInputSchema } from '../onboarding/contracts';
import { BillingService } from '../billing/subscription';

interface OnboardingConfigureBody {
  name: string;
  businessName: string;
  services: string[];
  teamSize: string;
  workerTerm: string;
  jobTerm: string;
  estimateTerm: string;
  automationRules: { id: string; enabled: boolean }[];
}

/** Map onboarding service names to vertical pack IDs. */
const SERVICE_TO_PACK: Record<string, string> = {
  HVAC: 'hvac',
  Plumbing: 'plumbing',
  Painting: 'painting',
  Electrical: 'electrical',
  Contracting: 'contracting',
};

export interface OnboardingRouterDeps {
  settingsRepo: SettingsRepository;
  packActivationRepo: PackActivationRepository;
  auditRepo: AuditRepository;
  pool?: Pool;
  billingService?: BillingService;
}

export function createOnboardingRouter(deps: OnboardingRouterDeps): Router {
  const { settingsRepo, packActivationRepo, auditRepo, pool, billingService } = deps;
  const router = Router();

  router.get(
    '/status',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Onboarding status requires a database connection',
          });
          return;
        }

        const tenantId = req.auth!.tenantId;
        const facts = await loadOnboardingFacts({ pool, settingsRepo }, tenantId);
        const status = deriveOnboardingStatus(facts);
        res.set('Cache-Control', 'private, max-age=2');
        res.json(status);
      } catch (error: unknown) {
        res.status(500).json({
          error: 'ONBOARDING_STATUS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to load onboarding status',
        });
      }
    }
  );

  router.post(
    '/configure',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      const body = req.body as OnboardingConfigureBody;
      const tenantId = req.auth!.tenantId;
      const userId = req.auth!.userId;

      // Validate required fields
      if (!body?.businessName) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'businessName is required' });
        return;
      }

      const terminologyPreferences: Record<string, string> = {};
      if (body.workerTerm) terminologyPreferences.workerTerm = body.workerTerm;
      if (body.jobTerm) terminologyPreferences.jobTerm = body.jobTerm;
      if (body.estimateTerm) terminologyPreferences.estimateTerm = body.estimateTerm;
      if (body.teamSize) terminologyPreferences.teamSize = body.teamSize;
      if (body.name) terminologyPreferences.ownerName = body.name;

      // Upsert tenant settings
      const existing = await settingsRepo.findByTenant(tenantId);
      let settings: TenantSettings | null;

      if (existing) {
        settings = await settingsRepo.update(tenantId, {
          businessName: body.businessName,
          terminologyPreferences,
          activeVerticalPacks: body.services
            .map(s => SERVICE_TO_PACK[s])
            .filter(Boolean),
        });
      } else {
        settings = await settingsRepo.create({
          id: uuidv4(),
          tenantId,
          businessName: body.businessName,
          timezone: 'America/New_York',
          estimatePrefix: 'EST-',
          invoicePrefix: 'INV-',
          nextEstimateNumber: 1001,
          nextInvoiceNumber: 1001,
          defaultPaymentTermDays: 30,
          terminologyPreferences,
          activeVerticalPacks: body.services
            .map(s => SERVICE_TO_PACK[s])
            .filter(Boolean),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Activate vertical packs for selected services
      for (const service of body.services) {
        const packId = SERVICE_TO_PACK[service];
        if (!packId) continue;
        try {
          await activatePack({ tenantId, packId }, packActivationRepo);
        } catch {
          // Pack already active — ignore
        }
      }

      // Emit audit event
      await auditRepo.create(createAuditEvent({
        tenantId,
        actorId: userId,
        actorRole: 'owner',
        eventType: existing ? 'onboarding_update' : 'onboarding_complete',
        entityType: 'tenant_settings',
        entityId: settings?.id || tenantId,
        metadata: {
          businessName: body.businessName,
          services: body.services,
          teamSize: body.teamSize,
          terminology: terminologyPreferences,
          automationRules: body.automationRules,
        },
      }));

      res.json({
        settings,
        activatedPacks: body.services.map(s => SERVICE_TO_PACK[s]).filter(Boolean),
      });
    }
  );

  router.put(
    '/identity',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Onboarding identity requires a database connection',
          });
          return;
        }

        const parsed = BusinessIdentityInputSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
          return;
        }

        const tenantId = req.auth!.tenantId;
        const userId = req.auth!.userId;
        const v = parsed.data;

        await pool.query(
          `INSERT INTO tenant_settings (
             id, tenant_id, business_name, service_area_text, service_area_radius,
             business_hours, job_buffer_minutes, hourly_rate_cents,
             timezone, estimate_prefix, invoice_prefix, next_estimate_number,
             next_invoice_number, default_payment_term_days
           )
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7,
                   'America/New_York', 'EST-', 'INV-', 1001, 1001, 30)
           ON CONFLICT (tenant_id) DO UPDATE SET
             business_name        = EXCLUDED.business_name,
             service_area_text    = EXCLUDED.service_area_text,
             service_area_radius  = EXCLUDED.service_area_radius,
             business_hours       = EXCLUDED.business_hours,
             job_buffer_minutes   = EXCLUDED.job_buffer_minutes,
             hourly_rate_cents    = EXCLUDED.hourly_rate_cents,
             updated_at           = now()`,
          [
            tenantId,
            v.businessName,
            v.serviceAreaText ?? null,
            v.serviceAreaRadius ?? null,
            JSON.stringify(v.businessHours),
            v.jobBufferMinutes,
            v.hourlyRateCents,
          ]
        );

        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: userId,
            actorRole: 'owner',
            eventType: 'tenant.identity_set',
            entityType: 'tenant_settings',
            entityId: tenantId,
            metadata: { businessName: v.businessName, hourlyRateCents: v.hourlyRateCents },
          })
        );

        res.json({ ok: true });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'IDENTITY_SAVE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to save business identity',
        });
      }
    }
  );

  router.post(
    '/pack',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Onboarding pack requires a database connection',
          });
          return;
        }

        const parsed = PackPickInputSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
          return;
        }

        const tenantId = req.auth!.tenantId;
        const userId = req.auth!.userId;
        const { packId } = parsed.data;

        // Read current settings to get existing activeVerticalPacks
        const existing = await settingsRepo.findByTenant(tenantId);
        const currentPacks = existing?.activeVerticalPacks ?? [];
        const newPacks = Array.from(new Set([...currentPacks, packId])); // Idempotent union

        if (existing) {
          // Update existing row
          await settingsRepo.update(tenantId, { activeVerticalPacks: newPacks });
        } else {
          // Auto-create minimal settings row if tenant hasn't called /identity yet
          await settingsRepo.create({
            id: uuidv4(),
            tenantId,
            businessName: '', // Will remain empty until /identity is called
            timezone: 'America/New_York',
            estimatePrefix: 'EST-',
            invoicePrefix: 'INV-',
            nextEstimateNumber: 1001,
            nextInvoiceNumber: 1001,
            defaultPaymentTermDays: 30,
            activeVerticalPacks: newPacks,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }

        // Emit audit event
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: userId,
            actorRole: 'owner',
            eventType: 'tenant.pack_activated',
            entityType: 'tenant_packs',
            entityId: packId,
            metadata: { packId },
          })
        );

        res.json({ ok: true, packId });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'PACK_ACTIVATION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to activate pack',
        });
      }
    }
  );

  router.post(
    '/test-call/skip',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Onboarding test-call skip requires a database connection',
          });
          return;
        }

        const tenantId = req.auth!.tenantId;
        const userId = req.auth!.userId;

        // INSERT ... ON CONFLICT to mark test_call as skipped
        await pool.query(
          `INSERT INTO tenant_settings (id, tenant_id, timezone, estimate_prefix, invoice_prefix,
             next_estimate_number, next_invoice_number, default_payment_term_days,
             onboarding_test_call_skipped_at, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'America/New_York', 'EST-', 'INV-',
                   1001, 1001, 30, now(), now(), now())
           ON CONFLICT (tenant_id) DO UPDATE SET
             onboarding_test_call_skipped_at = now(),
             updated_at = now()`,
          [tenantId]
        );

        // Emit audit event
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: userId,
            actorRole: 'owner',
            eventType: 'tenant.test_call_skipped',
            entityType: 'tenant_settings',
            entityId: tenantId,
            metadata: {},
          })
        );

        // Return the freshly-derived status
        const facts = await loadOnboardingFacts({ pool, settingsRepo }, tenantId);
        const status = deriveOnboardingStatus(facts);
        res.json(status);
      } catch (error: unknown) {
        res.status(500).json({
          error: 'TEST_CALL_SKIP_FAILED',
          message: error instanceof Error ? error.message : 'Failed to skip test call',
        });
      }
    }
  );

  /**
   * POST /api/onboarding/billing/checkout-session
   *
   * Mints a Stripe Checkout Session for the 14-day trial subscription.
   * Requires billingService (503 when Stripe is not configured).
   * Returns { url } for the operator to redirect to.
   */
  router.post(
    '/billing/checkout-session',
    requireAuth,
    requireTenant,
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
        const email = req.clerkUser?.email;
        if (!email) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Owner email not present on auth context',
          });
          return;
        }

        const webUrl = process.env.WEB_URL ?? 'http://localhost:5173';
        const successUrl = `${webUrl}/onboarding?billing=ok`;
        const cancelUrl = `${webUrl}/onboarding?billing=cancel`;

        const result = await billingService.createTrialCheckoutSession({
          tenantId,
          ownerEmail: email,
          successUrl,
          cancelUrl,
        });
        res.json(result);
      } catch (err: unknown) {
        res.status(500).json({
          error: 'CHECKOUT_SESSION_FAILED',
          message: err instanceof Error ? err.message : 'Failed to create checkout session',
        });
      }
    }
  );

  return router;
}
