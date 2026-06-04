import { Router, Response } from 'express';
import type { Pool } from 'pg';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import { currentTenantContext } from '../middleware/tenant-context';
import { toErrorResponse } from '../shared/errors';
import { SettingsRepository } from '../settings/settings';
import { PackActivationRepository, activatePack } from '../settings/pack-activation';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { v4 as uuidv4 } from 'uuid';
import { loadOnboardingFacts } from '../onboarding/load-facts';
import { deriveOnboardingStatus } from '../onboarding/derive-status';
import {
  BusinessIdentityInputSchema,
  BusinessHoursSchema,
  PackPickInputSchema,
} from '../onboarding/contracts';
import { BillingService } from '../billing/subscription';
import type { Queue } from '../queues/queue';
import {
  PROVISION_TWILIO_JOB_TYPE,
  type ProvisionTwilioPayload,
} from '../workers/provision-twilio';
import { VERIFY_AI_JOB_TYPE, type VerifyAiPayload } from '../workers/verify-ai';
import {
  seedPackDefaults,
  type SeedPackDefaultsDeps,
} from '../packs/seed-pack-defaults';
import { normalizeMobileE164 } from '../shared/phone/normalize';
import { isValidIanaTimezone, resolveBootstrapAiModel } from '../settings/settings';

export interface OnboardingRouterDeps {
  settingsRepo: SettingsRepository;
  packActivationRepo: PackActivationRepository;
  auditRepo: AuditRepository;
  pool?: Pool;
  billingService?: BillingService;
  queue?: Queue;
  /**
   * When provided, /api/onboarding/pack auto-seeds canonical job types,
   * price-book entries, and customer-message defaults for the picked
   * pack. Without this, the wizard's promise of "we'll set up job types,
   * pricing, and message templates for you" goes unfulfilled and new
   * tenants land on an empty estimate page.
   */
  packSeedDeps?: SeedPackDefaultsDeps;
}

export function createOnboardingRouter(deps: OnboardingRouterDeps): Router {
  const {
    settingsRepo,
    packActivationRepo,
    auditRepo,
    pool,
    billingService,
    queue,
    packSeedDeps,
  } = deps;
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

  router.put(
    '/identity',
    requireAuth,
    requireTenant,
    // /identity rewrites business_name, hourly_rate_cents,
    // business_hours, timezone, AND owner_phone — the same fields
    // guarded by settings:update / tenant:manage on the main
    // mutation routes. Without an owner gate here, a dispatcher or
    // technician could overwrite the owner's personal cell. Same
    // shape as /pack and /billing/cancel.
    requireRole('owner'),
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
        const db = currentTenantContext()?.client ?? pool;

        // Timezone: prefer the value the client submitted (browser-detected
        // IANA name), then keep whatever was previously stored, then fall
        // back to ET as last-resort default for the initial INSERT.
        // Validated via Intl.DateTimeFormat so any runtime-recognized
        // IANA zone (e.g. America/Adak, America/North_Dakota/Center) is
        // accepted, but bogus strings like "Foo/Bar" still 400 instead
        // of silently corrupting tenant_settings.timezone and blowing up
        // downstream Intl callers later.
        const submittedTimezone = v.timezone?.trim() || null;
        if (submittedTimezone && !isValidIanaTimezone(submittedTimezone)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            issues: [{
              path: ['timezone'],
              message: `"${submittedTimezone}" is not a recognized IANA timezone.`,
            }],
          });
          return;
        }

        // Owner phone: empty string explicitly clears (SQL NULL); omitted
        // leaves the existing value untouched; a populated value is
        // normalized to E.164 — invalid input returns 400 with a clear
        // message instead of being silently dropped.
        let ownerPhoneToWrite: string | null | undefined = undefined;
        if (v.ownerPhone !== undefined) {
          const trimmed = v.ownerPhone.trim();
          if (trimmed === '') {
            ownerPhoneToWrite = null;
          } else {
            try {
              ownerPhoneToWrite = normalizeMobileE164(trimmed);
            } catch (err) {
              res.status(400).json({
                error: 'VALIDATION_ERROR',
                issues: [{
                  path: ['ownerPhone'],
                  message: err instanceof Error ? err.message : 'Invalid owner phone number',
                }],
              });
              return;
            }
          }
        }

        // Seed the platform default AI model on the very first INSERT so
        // the onboarding "AI check" (Step 6) finds aiConfigPresent=true. The
        // COALESCE on update keeps any tenant-specific override the user
        // has already set elsewhere — same convention as the timezone and
        // owner_phone columns below.
        const bootstrapAiModel = resolveBootstrapAiModel();

        await db.query(
          `INSERT INTO tenant_settings (
             id, tenant_id, business_name, service_area_text, service_area_radius,
             business_hours, job_buffer_minutes, hourly_rate_cents,
             timezone, owner_phone, ai_model, estimate_prefix, invoice_prefix, next_estimate_number,
             next_invoice_number, default_payment_term_days
           )
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7,
                   COALESCE($8, 'America/New_York'),
                   $9, $11,
                   'EST-', 'INV-', 1001, 1001, 30)
           ON CONFLICT (tenant_id) DO UPDATE SET
             business_name        = EXCLUDED.business_name,
             service_area_text    = EXCLUDED.service_area_text,
             service_area_radius  = EXCLUDED.service_area_radius,
             business_hours       = EXCLUDED.business_hours,
             job_buffer_minutes   = EXCLUDED.job_buffer_minutes,
             hourly_rate_cents    = EXCLUDED.hourly_rate_cents,
             timezone             = COALESCE($8, tenant_settings.timezone),
             owner_phone          = CASE
               WHEN $10::boolean THEN $9
               ELSE tenant_settings.owner_phone
             END,
             ai_model             = COALESCE(tenant_settings.ai_model, $11),
             updated_at           = now()`,
          [
            tenantId,
            v.businessName,
            v.serviceAreaText ?? null,
            v.serviceAreaRadius ?? null,
            JSON.stringify(v.businessHours),
            v.jobBufferMinutes,
            v.hourlyRateCents,
            submittedTimezone,
            ownerPhoneToWrite ?? null,
            ownerPhoneToWrite !== undefined,
            bootstrapAiModel,
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
    // Pack activation seeds rows into catalog_items and
    // estimate_templates — the same tables that the main mutation
    // routes guard with settings:update and estimates:create. Without
    // an owner-role gate here, a dispatcher or technician with a
    // valid session could call /api/onboarding/pack and alter the
    // tenant's price book + job types. Onboarding is owner-driven
    // anyway (the wizard runs for the operator who signed up), so
    // restricting to owner matches the actual flow.
    requireRole('owner'),
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
            // Seed the platform default AI model so the onboarding
            // "AI check" (Step 6) finds aiConfigPresent=true. Same
            // value the ensureTenantSettings bootstrap path uses.
            aiModel: resolveBootstrapAiModel(),
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }

        // Serialize pack activation + seed per (tenant, pack) via a
        // Postgres advisory transaction lock. Two concurrent /pack
        // requests for the same tenant+pack could both pass the
        // "already activated" branch and reach the seed probe before
        // either has committed; both would then observe an empty
        // catalog/template set and INSERT a full duplicate. Lock is
        // held until COMMIT (end of this request transaction); a
        // concurrent caller's try-lock returns false and gets a
        // clear 409 message.
        const ctx = currentTenantContext();
        if (ctx) {
          const lockRes = await ctx.client.query<{ locked: boolean }>(
            `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked`,
            [`pack:${tenantId}:${packId}`],
          );
          if (!lockRes.rows[0]?.locked) {
            res.status(409).json({
              error: 'PACK_ACTIVATION_IN_PROGRESS',
              message: 'Another pack activation is already running for this tenant. Wait a moment and try again.',
            });
            return;
          }
        }

        try {
          await activatePack({ tenantId, packId }, packActivationRepo);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (!msg.includes('already activated')) {
            throw err;
          }
        }

        // Auto-seed canonical job types, price book, and message-template
        // defaults so the wizard's "we'll set this up for you" promise is
        // real. Idempotent: safe to re-run because each helper checks
        // for the canonical names first.
        //
        // We do NOT swallow seed errors here. Every /api route runs inside
        // withTenantTransaction, and catching a SQL error mid-transaction
        // leaves the connection in an aborted state — the auditRepo.create
        // call below would then fail with "current transaction is aborted,
        // commands ignored until end of transaction block." Letting the
        // error propagate rolls the whole request back (including the
        // pack_activation write) so the next click retries cleanly with
        // no partial seed left behind.
        let seedResult: Awaited<ReturnType<typeof seedPackDefaults>> | null = null;
        if (packSeedDeps) {
          seedResult = await seedPackDefaults(
            { tenantId, packId, actorId: userId },
            packSeedDeps,
          );
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
            metadata: {
              packId,
              ...(seedResult
                ? {
                    seedAlreadyApplied: seedResult.alreadySeeded,
                    catalogItemsCreated: seedResult.catalogItemsCreated,
                    templatesCreated: seedResult.templatesCreated,
                  }
                : {}),
            },
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

        // Ensure a tenant_settings row exists before stamping the skip
        // timestamp. business_name is NOT NULL with no default, so a raw
        // INSERT that omits it fails. Match /pack's pattern: use the
        // settings repo to create the minimal row, then raw UPDATE the
        // new column directly (repo doesn't yet expose it).
        const existing = await settingsRepo.findByTenant(tenantId);
        if (!existing) {
          await settingsRepo.create({
            id: uuidv4(),
            tenantId,
            businessName: '', // placeholder; /identity will populate
            timezone: 'America/New_York',
            estimatePrefix: 'EST-',
            invoicePrefix: 'INV-',
            nextEstimateNumber: 1001,
            nextInvoiceNumber: 1001,
            defaultPaymentTermDays: 30,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        const db = currentTenantContext()?.client ?? pool;
        await db.query(
          `UPDATE tenant_settings
             SET onboarding_test_call_skipped_at = now(), updated_at = now()
           WHERE tenant_id = $1`,
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

  router.get(
    '/operator-hours',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Operator hours requires a database connection',
          });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const db = currentTenantContext()?.client ?? pool;
        const row = await db.query<{ business_hours: unknown }>(
          `SELECT business_hours FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
          [tenantId],
        );
        const settings = await settingsRepo.findByTenant(tenantId);
        res.json({
          businessHours: row.rows[0]?.business_hours ?? {},
          afterHoursVoiceMode:
            settings?.escalationSettings?.after_hours_voice_mode ?? 'voicemail',
        });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'OPERATOR_HOURS_LOAD_FAILED',
          message: error instanceof Error ? error.message : 'Failed to load operator hours',
        });
      }
    },
  );

  router.put(
    '/operator-hours',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Operator hours requires a database connection',
          });
          return;
        }
        const parsed = BusinessHoursSchema.safeParse(req.body?.businessHours ?? req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const userId = req.auth!.userId;
        const db = currentTenantContext()?.client ?? pool;
        await db.query(
          `UPDATE tenant_settings
             SET business_hours = $2::jsonb, updated_at = now()
           WHERE tenant_id = $1`,
          [tenantId, JSON.stringify(parsed.data)],
        );
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: userId,
            actorRole: 'owner',
            eventType: 'tenant.operator_hours_updated',
            entityType: 'tenant_settings',
            entityId: tenantId,
          }),
        );
        res.json({ ok: true, businessHours: parsed.data });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'OPERATOR_HOURS_SAVE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to save operator hours',
        });
      }
    },
  );

  router.post(
    '/phone/retry',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool || !queue) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Phone retry requires database and queue',
          });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const db = currentTenantContext()?.client ?? pool;
        const integ = await db.query<{ status: string }>(
          `SELECT status FROM tenant_integrations
           WHERE tenant_id = $1 AND provider = 'twilio' LIMIT 1`,
          [tenantId],
        );
        const status = integ.rows[0]?.status;
        if (status === 'full_readiness') {
          res.json({ ok: true, skipped: true, reason: 'already_active' });
          return;
        }
        if (status && status !== 't0_requested' && status !== 'failed') {
          res.status(409).json({
            error: 'PHONE_RETRY_NOT_ALLOWED',
            message: `Cannot retry from status ${status}`,
          });
          return;
        }
        const callbackBaseUrl =
          process.env.PUBLIC_API_URL ??
          process.env.APP_PUBLIC_URL ??
          'http://localhost:3000';
        const payload: ProvisionTwilioPayload = {
          tenantId,
          region: null,
          baseUrl: callbackBaseUrl,
        };
        await queue.send(
          PROVISION_TWILIO_JOB_TYPE,
          payload,
          `provision-twilio-retry-${tenantId}`,
        );
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: 'owner',
            eventType: 'tenant.phone_provisioning_retry',
            entityType: 'tenant_integrations',
            entityId: tenantId,
          }),
        );
        res.json({ ok: true, enqueued: true });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'PHONE_RETRY_FAILED',
          message: error instanceof Error ? error.message : 'Failed to retry phone provisioning',
        });
      }
    },
  );

  router.post(
    '/ai-check/retry',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool || !queue) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'AI check retry requires database and queue',
          });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
          await client.query(
            `UPDATE tenant_settings
               SET ai_verification_status = 'pending',
                   ai_verification_error = NULL,
                   updated_at = now()
             WHERE tenant_id = $1`,
            [tenantId],
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
        const payload: VerifyAiPayload = { tenantId };
        await queue.send(VERIFY_AI_JOB_TYPE, payload, `verify-ai-retry-${tenantId}`);
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: 'owner',
            eventType: 'tenant.ai_verification_retry',
            entityType: 'tenant_settings',
            entityId: tenantId,
          }),
        );
        res.json({ ok: true, enqueued: true });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'AI_CHECK_RETRY_FAILED',
          message: error instanceof Error ? error.message : 'Failed to retry AI verification',
        });
      }
    },
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
        // ValidationError from createTrialCheckoutSession (already
        // subscribed, checkout in progress, etc.) must surface as
        // 400 with its actionable message — otherwise BillingStep
        // shows the generic "Stripe is temporarily unavailable"
        // copy reserved for real 5xx outages.
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  /**
   * POST /api/onboarding/billing/cancel
   *
   * Called from OnboardingShell when the operator returns via Stripe's
   * cancel_url (?billing=cancel). Clears tenants.pending_checkout_at so
   * the trial-checkout gate reopens immediately — without this, the
   * gate would refuse new checkouts for the full 30-minute staleness
   * window even after an intentional cancel, contradicting the toast
   * that says they can subscribe when ready.
   *
   * Self-service action on the requesting tenant's own row, no Stripe
   * round-trip. The Stripe session itself expires at the same 30-min
   * mark (expires_at is bound in createTrialCheckoutSession) so a
   * malicious clear can't outlive Stripe's session lifetime anyway.
   */
  router.post(
    '/billing/cancel',
    requireAuth,
    requireTenant,
    // Same authorization as the billing portal (routes/billing.ts uses
    // tenant:manage there): this endpoint EXPIREs the active Stripe
    // checkout session and clears the gate, so a dispatcher or
    // technician could otherwise DOS the owner's onboarding by
    // repeatedly canceling whatever the owner just started.
    requireRole('owner'),
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
        // No body needed — the Stripe session id is read from the
        // tenants row (createTrialCheckoutSession persisted it).
        // Stripe only interpolates {CHECKOUT_SESSION_ID} into
        // success_url, never cancel_url, so the client has no
        // reliable way to send us the right id.
        await billingService.clearPendingCheckout(tenantId);
        res.json({ ok: true });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
