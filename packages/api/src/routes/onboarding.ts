import { Router, Response } from 'express';
import { recordFunnelEvent } from '../analytics/posthog';
import { z } from 'zod';
import type { Pool } from 'pg';
import { AuthenticatedRequest } from '../auth/clerk';
import { resolveOwnerEmail } from '../auth/resolve-owner-email';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import { currentTenantContext } from '../middleware/tenant-context';
import { toErrorResponse } from '../shared/errors';
import { publicUrl } from '../shared/public-origins';
import { SettingsRepository } from '../settings/settings';
import { PackActivationRepository } from '../settings/pack-activation';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { activatePackWithSeed } from '../onboarding/activate-pack-with-seed';
import { v4 as uuidv4 } from 'uuid';
import { loadOnboardingFacts } from '../onboarding/load-facts';
import { deriveOnboardingStatus } from '../onboarding/derive-status';
import { toPhoneLineView, AUTO_PICK, type TwilioIntegrationRow } from '../onboarding/phone-line';
import {
  BusinessIdentityInputSchema,
  BusinessHoursSchema,
  PackPickInputSchema,
  VoiceConfigInputSchema,
  CalendarChoiceInputSchema,
  PhoneAvailableInputSchema,
  PhoneClaimInputSchema,
} from '../onboarding/contracts';
import { searchAvailableNumbers } from '../integrations/twilio/provisioning';
import { saveVoiceConfig } from '../voice/voice-config';
import { VOICE_PRESETS } from '../integrations/vapi/assistant-config';
import { getVapiClient, type VapiClient } from '../integrations/vapi/client';
import { BillingService, BILLING_PLAN_IDS } from '../billing/subscription';
import type { Queue } from '../queues/queue';
import {
  PROVISION_TWILIO_JOB_TYPE,
  type ProvisionTwilioPayload,
} from '../workers/provision-twilio';
import { VERIFY_AI_JOB_TYPE, type VerifyAiPayload } from '../workers/verify-ai';
import {
  type SeedPackDefaultsDeps,
} from '../packs/seed-pack-defaults';
import { normalizeMobileE164 } from '../shared/phone/normalize';
import {
  isValidIanaTimezone,
  resolveBootstrapAiModel,
  resolveEscalationSettings,
} from '../settings/settings';
import { isBillingLiveStatus } from '../billing/tenant-billing-state';

/**
 * Trial-checkout gating for the phone routes. A Twilio number is real,
 * recurring money — /phone/retry and /phone/claim must not enqueue a
 * purchase for a tenant that hasn't completed billing (card on file). The
 * provisioning worker enforces the same invariant (see
 * billing/tenant-billing-state.ts); this guard fails fast with a clear 409
 * instead of enqueueing a job the worker will skip.
 */
async function isBillingLive(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ subscription_status: string | null }> }> },
  tenantId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT subscription_status FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return isBillingLiveStatus(rows[0]?.subscription_status);
}

/**
 * #1563 — record that the owner's pick (an E.164, or AUTO_PICK for "Pick one
 * for me") is in flight, so the phone step / Settings → Phone show "claiming
 * <number>…" instead of the picker while the worker runs. Upserts: the
 * checkout job may not have created the row yet. A previous failure is
 * cleared back to 't0_requested' — the new pick supersedes it.
 */
async function markPickPending(
  db: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  tenantId: string,
  pick: string,
): Promise<void> {
  await db.query(
    `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
     VALUES ($1, 'twilio', 't0_requested', $2::jsonb)
     ON CONFLICT (tenant_id, provider) DO UPDATE
       SET provider_data = tenant_integrations.provider_data || $2::jsonb,
           status = CASE WHEN tenant_integrations.status = 'failed'
                         THEN 't0_requested' ELSE tenant_integrations.status END,
           last_error = CASE WHEN tenant_integrations.status = 'failed'
                             THEN NULL ELSE tenant_integrations.last_error END,
           updated_at = NOW()`,
    [tenantId, JSON.stringify({ pendingPick: pick, awaitingPick: false })],
  );
}

function billingRequired(res: Response, verb: 'provisioning' | 'claiming'): void {
  res.status(409).json({
    error: 'PHONE_BILLING_REQUIRED',
    message: `Complete trial checkout before ${verb} a phone number.`,
  });
}

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
  /** Injectable Vapi client for voice-config assistant pushes. Defaults to
   * getVapiClient() (off-by-default without VAPI_API_KEY). */
  vapiClient?: VapiClient | null;
}

/**
 * Runs a single tenant-scoped write. A lone UPDATE is already atomic, so no
 * explicit transaction is needed — just set the RLS tenant id and run it.
 */
async function tenantWrite(pool: Pool, tenantId: string, sql: string, params: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query(sql, params);
  } finally {
    client.release();
  }
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

  // Explicit plan selection only — the browser sends an id from this
  // allowlist, never a Stripe price. See billing/subscription.ts
  // BILLING_PLAN_IDS / createTrialCheckoutSession.
  const BillingCheckoutInputSchema = z.object({
    planId: z.enum(BILLING_PLAN_IDS),
  });

  router.get(
    '/status',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          // Hermetic / no-DB boot: return a soft status from settings so the
          // Settings "AI phone answering" toggle is not stuck on Loading…
          // forever (503 left voiceAgentLive === null in the web client).
          //
          // Soft identity: webhook / ensureTenantSettings only seeds
          // businessName. Without a pool, PUT /identity is 503, so we cannot
          // finish the real wizard. Previously a 503 left useOnboardingStatus
          // data=null and OnboardingGuard kept CRM open. Returning incomplete
          // identity here hard-redirects to /onboarding and breaks hermetic
          // journeys (e.g. EST-0001 never visible on /estimates). When a
          // settings row exists, treat identity as done for CRM unlock only.
          const settings = await settingsRepo.findByTenant(req.auth!.tenantId);
          const seededName = settings?.businessName?.trim() || null;
          const softIdentityDone = seededName != null;
          const status = deriveOnboardingStatus({
            tenantId: req.auth!.tenantId,
            tenantExists: true,
            identity: {
              businessName: seededName,
              businessHours:
                settings?.businessHours ??
                (softIdentityDone
                  ? { monday: { open: '09:00', close: '17:00' } }
                  : null),
              jobBufferMinutes:
                settings?.jobBufferMinutes ?? (softIdentityDone ? 15 : null),
              hourlyRateCents:
                settings?.hourlyRateCents ?? (softIdentityDone ? 15000 : null),
              // Soft-filled like the three above, and for the same
              // CRM-unlock reason — `isIdentityDone` requires a zone because
              // a tenant without one cannot book. This is NOT the defaulting
              // migration 263 outlawed: nothing here is written to
              // tenant_settings (there is no pool), so no appointment can be
              // misbooked by it. Per settings.ts's rule, a consumer that
              // merely DISPLAYS may substitute; one that BOOKS must gate —
              // and the booking path still reads the real (absent) column.
              timezone: settings?.timezone ?? (softIdentityDone ? 'UTC' : null),
            },
            packActivated: false,
            twilioStatus: null,
            subscription: { stripeSubscriptionId: null, status: null },
            inboundCallCount: 0,
            testCallSkippedAt: null,
            voiceAgentLiveAt: null,
            activatedAt: null,
            aiConfigPresent: Boolean(settings?.aiModel),
            aiVerificationStatus: null,
            aiVerificationSkippedAt: null,
          });
          res.set('Cache-Control', 'private, max-age=2');
          res.json(status);
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

        // B1.19 — the actual upsert lives in SettingsRepository.upsertIdentityFields
        // (packages/api/src/settings/pg-settings.ts), a single atomic
        // INSERT ... ON CONFLICT shared with the conversational
        // onboarding_tenant_settings / onboarding_schedule execution
        // handlers (proposals/execution/onboarding-handlers.ts) — both
        // paths write tenant identity through the SAME implementation.
        await settingsRepo.upsertIdentityFields(tenantId, {
          businessName: v.businessName,
          serviceAreaText: v.serviceAreaText ?? undefined,
          // #874 tri-state: forward null (explicit clear) as-is; only an
          // omitted field keeps the stored radius.
          ...(v.serviceAreaRadius !== undefined
            ? { serviceAreaRadius: v.serviceAreaRadius }
            : {}),
          businessHours: v.businessHours,
          jobBufferMinutes: v.jobBufferMinutes,
          hourlyRateCents: v.hourlyRateCents,
          timezone: submittedTimezone ?? undefined,
          // Tri-state: only include the key when the caller actually sent
          // ownerPhone, so an omitted field leaves the stored value alone
          // (matches the original ownerPhoneToWrite flag).
          ...(v.ownerPhone !== undefined ? { ownerPhone: ownerPhoneToWrite ?? null } : {}),
          bootstrapAiModel,
        });

        // Feature 2 extras (migration 148) — persisted in a separate additive
        // UPDATE so the proven identity INSERT above stays untouched. Each
        // field is COALESCE'd so an omitted value leaves the stored one intact.
        if (
          v.serviceAddress !== undefined ||
          v.serviceAreaZips !== undefined ||
          v.servicesOffered !== undefined
        ) {
          await db.query(
            `UPDATE tenant_settings SET
               service_address  = COALESCE($2, service_address),
               service_area_zips = COALESCE($3::text[], service_area_zips),
               services_offered  = COALESCE($4::text[], services_offered),
               updated_at = now()
             WHERE tenant_id = $1`,
            [
              tenantId,
              v.serviceAddress ?? null,
              v.serviceAreaZips ?? null,
              v.servicesOffered ?? null,
            ],
          );
        }

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
        const { packId, tradeLabel } = parsed.data;

        // B1.19 — the actual activate+seed logic lives in
        // activatePackWithSeed (src/onboarding/activate-pack-with-seed.ts),
        // shared with the conversational onboarding_tenant_settings /
        // onboarding_service_category execution handlers
        // (proposals/execution/onboarding-handlers.ts) — both paths
        // write through the SAME implementation. We do NOT swallow seed
        // errors here: every /api route runs inside withTenantTransaction,
        // and catching a SQL error mid-transaction leaves the connection
        // aborted (the auditRepo.create call inside activatePackWithSeed
        // would then fail too). Letting the error propagate rolls the
        // whole request back so the next click retries cleanly.
        const result = await activatePackWithSeed(
          { tenantId, packId, tradeLabel, actorId: userId, lockClient: currentTenantContext()?.client },
          { settingsRepo, packActivationRepo, auditRepo, packSeedDeps },
        );
        if (result.status === 'locked') {
          res.status(409).json({
            error: 'PACK_ACTIVATION_IN_PROGRESS',
            message: 'Another pack activation is already running for this tenant. Wait a moment and try again.',
          });
          return;
        }

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
            // No guessed timezone — see /pack's seeder above.
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
          // #1595 / D-039 — report the mode the phone will actually use: the
          // same resolved default (ai_answering) the /voice webhook applies,
          // never a hardcoded fallback that can drift from it.
          afterHoursVoiceMode: resolveEscalationSettings(settings).after_hours_voice_mode,
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

  // #1563 — the business line as Settings → Phone (and the onboarding phone
  // step) shows it: number, provisioning state, in-flight pick / change.
  router.get(
    '/phone',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Phone status requires database',
          });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const db = currentTenantContext()?.client ?? pool;
        const { rows } = await db.query<TwilioIntegrationRow>(
          `SELECT status, last_error, provider_data FROM tenant_integrations
           WHERE tenant_id = $1 AND provider = 'twilio' LIMIT 1`,
          [tenantId],
        );
        res.json(toPhoneLineView(rows[0]));
      } catch (error: unknown) {
        res.status(500).json({
          error: 'PHONE_STATUS_FAILED',
          message: error instanceof Error ? error.message : 'Failed to load phone status',
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
        // Trial-checkout gating: never enqueue a number purchase before the
        // tenant has a card on file.
        if (!(await isBillingLive(db, tenantId))) {
          billingRequired(res, 'provisioning');
          return;
        }
        const callbackBaseUrl =
          process.env.PUBLIC_API_URL ??
          process.env.APP_PUBLIC_URL ??
          'http://localhost:3000';
        // #1563 — "Pick one for me": an explicit buy. The checkout job only
        // sets up the subaccount + Messaging Service; this job also buys a
        // number (business-address area code first, then any US local). Its
        // own key, so it never collapses into a pending checkout job.
        const payload: ProvisionTwilioPayload = {
          tenantId,
          region: null,
          baseUrl: callbackBaseUrl,
          autoPick: true,
        };
        await markPickPending(db, tenantId, AUTO_PICK);
        await queue.send(
          PROVISION_TWILIO_JOB_TYPE,
          payload,
          `provision-twilio-autopick-${tenantId}`,
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

  // Number picker — list purchasable numbers for an area code. Read-only:
  // searches Twilio on the MASTER account (no subaccount needed yet), so the
  // picker works before provisioning creates the tenant's subaccount. The
  // actual (costly) purchase stays server-side in the worker (/phone/claim).
  router.post(
    '/phone/available',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = PhoneAvailableInputSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: 'INVALID_AREA_CODE',
            message: parsed.error.issues[0]?.message ?? 'Invalid area code',
          });
          return;
        }
        const masterSid = process.env.TWILIO_ACCOUNT_SID;
        const masterToken = process.env.TWILIO_AUTH_TOKEN;
        if (!masterSid || !masterToken) {
          // Twilio unconfigured (e.g. local dev) — the picker UI falls back to
          // "let us pick a number for you" (the existing region-based retry).
          res.status(503).json({
            error: 'TWILIO_NOT_CONFIGURED',
            message: 'Phone number search is not available',
          });
          return;
        }
        const numbers = await searchAvailableNumbers(masterSid, masterToken, {
          areaCode: parsed.data.areaCode,
          limit: parsed.data.limit ?? 10,
        });
        res.json({ numbers });
      } catch (error: unknown) {
        res.status(502).json({
          error: 'PHONE_SEARCH_FAILED',
          message: error instanceof Error ? error.message : 'Failed to search available numbers',
        });
      }
    },
  );

  // Number picker — claim the specific number the tradesperson chose. Mirrors
  // /phone/retry's status gate, but threads the chosen E.164 to the worker so
  // it orders exactly that number. The purchase itself (money, hard to undo)
  // stays server-side in the worker — the client never buys directly.
  router.post(
    '/phone/claim',
    requireAuth,
    requireTenant,
    // Claiming commits the tenant to a specific paid DID (recurring cost), so
    // gate it to the owner — matching /pack and /billing, the other routes
    // that spend money or change billing.
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool || !queue) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Phone claim requires database and queue',
          });
          return;
        }
        const parsed = PhoneClaimInputSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: 'INVALID_PHONE_NUMBER',
            message: parsed.error.issues[0]?.message ?? 'Invalid phone number',
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
            error: 'PHONE_CLAIM_NOT_ALLOWED',
            message: `Cannot claim from status ${status}`,
          });
          return;
        }
        // Trial-checkout gating: never enqueue a number purchase before the
        // tenant has a card on file.
        if (!(await isBillingLive(db, tenantId))) {
          billingRequired(res, 'claiming');
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
          phoneNumber: parsed.data.phoneNumber,
        };
        // #1563 — a claim gets its OWN idempotency key, one per (tenant,
        // number) intent. It used to share the trial-checkout job's key, so
        // a pick made while that job was pending/in flight was silently
        // dropped by PgQueue's ON CONFLICT DO NOTHING while this route still
        // answered {enqueued:true}. Double-provisioning is prevented in the
        // worker instead: every provisioning job for a tenant runs under one
        // per-tenant advisory lock, and the number step is idempotent (an
        // already-active tenant or an already-owned number is never re-bought).
        // Re-claiming the same number while that claim is still pending
        // collapses onto it — the same intent, honestly reported as enqueued.
        await markPickPending(db, tenantId, parsed.data.phoneNumber);
        await queue.send(
          PROVISION_TWILIO_JOB_TYPE,
          payload,
          `provision-twilio-claim-${tenantId}-${parsed.data.phoneNumber.replace(/\D/g, '')}`,
        );
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: 'owner',
            eventType: 'tenant.phone_number_claimed',
            entityType: 'tenant_integrations',
            entityId: tenantId,
            metadata: { phoneNumber: parsed.data.phoneNumber },
          }),
        );
        res.json({ ok: true, enqueued: true, phoneNumber: parsed.data.phoneNumber });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'PHONE_CLAIM_FAILED',
          message: error instanceof Error ? error.message : 'Failed to claim phone number',
        });
      }
    },
  );

  // #1563 — Settings → Phone "change number". The worker buys the new number,
  // attaches it to the Messaging Service, repoints the tenant to it and only
  // then releases the old one; any failure before the repoint hands the new
  // number back and the tenant keeps its current line (never zero numbers).
  // Owner-only and billing-gated exactly like /phone/claim (it spends money).
  router.post(
    '/phone/change',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool || !queue) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'Phone change requires database and queue',
          });
          return;
        }
        const parsed = PhoneClaimInputSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: 'INVALID_PHONE_NUMBER',
            message: parsed.error.issues[0]?.message ?? 'Invalid phone number',
          });
          return;
        }
        const newNumber = parsed.data.phoneNumber;
        const tenantId = req.auth!.tenantId;
        const db = currentTenantContext()?.client ?? pool;
        const integ = await db.query<TwilioIntegrationRow>(
          `SELECT status, last_error, provider_data FROM tenant_integrations
           WHERE tenant_id = $1 AND provider = 'twilio' LIMIT 1`,
          [tenantId],
        );
        const line = toPhoneLineView(integ.rows[0]);
        if (line.state !== 'active') {
          res.status(409).json({
            error: 'PHONE_CHANGE_NOT_ALLOWED',
            message: 'You can change your number once your current number is active.',
          });
          return;
        }
        if (line.phoneNumber === newNumber) {
          res.status(409).json({
            error: 'PHONE_ALREADY_YOURS',
            message: 'That is already your business number.',
          });
          return;
        }
        if (!(await isBillingLive(db, tenantId))) {
          billingRequired(res, 'claiming');
          return;
        }
        // Compare-and-set: at most one change in flight per tenant, so two
        // quick taps can never buy two replacement numbers.
        const marked = await db.query(
          `UPDATE tenant_integrations
           SET provider_data = (provider_data - 'changeError') || $2::jsonb, updated_at = NOW()
           WHERE tenant_id = $1 AND provider = 'twilio' AND status = 'full_readiness'
             AND NOT (provider_data ? 'pendingChange')`,
          [tenantId, JSON.stringify({ pendingChange: newNumber })],
        );
        if ((marked as { rowCount?: number | null }).rowCount === 0) {
          res.status(409).json({
            error: 'PHONE_CHANGE_IN_PROGRESS',
            message: `Already switching to ${line.changingTo ?? 'a new number'} — give it a moment.`,
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
          changeTo: newNumber,
        };
        await queue.send(
          PROVISION_TWILIO_JOB_TYPE,
          payload,
          `provision-twilio-change-${tenantId}-${newNumber.replace(/\D/g, '')}`,
        );
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: 'owner',
            eventType: 'tenant.phone_number_change_requested',
            entityType: 'tenant_integrations',
            entityId: tenantId,
            metadata: { from: line.phoneNumber, to: newNumber },
          }),
        );
        res.json({ ok: true, enqueued: true, phoneNumber: newNumber });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'PHONE_CHANGE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to change phone number',
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
        await tenantWrite(
          pool,
          tenantId,
          `UPDATE tenant_settings
              SET ai_verification_status = 'pending',
                  ai_verification_error = NULL,
                  updated_at = now()
            WHERE tenant_id = $1`,
          [tenantId],
        );
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
   * POST /api/onboarding/ai-check/skip
   *
   * Escape hatch for a failed/flaky AI check: records the skip so the
   * ai_check step completes and onboarding can finish. Verification stays
   * retryable from Settings or the step itself. The skip never flips
   * ai_verification_status, so a later pass still records 'passed' on top.
   */
  router.post(
    '/ai-check/skip',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({
            error: 'ONBOARDING_NOT_CONFIGURED',
            message: 'AI check skip requires database',
          });
          return;
        }
        const tenantId = req.auth!.tenantId;
        await tenantWrite(
          pool,
          tenantId,
          `UPDATE tenant_settings
              SET ai_verification_skipped_at = now(),
                  updated_at = now()
            WHERE tenant_id = $1`,
          [tenantId],
        );
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: 'owner',
            eventType: 'tenant.ai_verification_skipped',
            entityType: 'tenant_settings',
            entityId: tenantId,
          }),
        );
        res.json({ ok: true, skipped: true });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'AI_CHECK_SKIP_FAILED',
          message: error instanceof Error ? error.message : 'Failed to skip AI verification',
        });
      }
    },
  );

  /**
   * GET /api/onboarding/billing/plans
   *
   * Validated, display-safe list of sellable plans (basic/enterprise) for
   * the billing step's plan picker: id, canonical Stripe product name,
   * and amount/interval — no price ids, no secrets. A plan whose env var
   * is unset or whose Stripe price fails validation is simply omitted
   * (see BillingService.listPlans); if nothing validates, this fails
   * closed with an actionable, non-secret 503 rather than silently
   * showing an empty/broken picker.
   */
  router.get(
    '/billing/plans',
    requireAuth,
    requireTenant,
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        if (!billingService) {
          res.status(503).json({
            error: 'BILLING_NOT_CONFIGURED',
            message: 'Subscription billing is not configured',
          });
          return;
        }
        const { plans } = await billingService.listPlans();
        if (plans.length === 0) {
          res.status(503).json({
            error: 'BILLING_PLANS_UNAVAILABLE',
            message: 'No billing plans are currently configured. Contact support.',
          });
          return;
        }
        res.json({ plans });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * POST /api/onboarding/billing/checkout-session
   *
   * Mints a Stripe Checkout Session for the 14-day trial subscription.
   * Requires billingService (503 when Stripe is not configured) AND an
   * explicit `planId` (basic|enterprise) in the body — there is no
   * default plan and no fallback price, so a missing/invalid selection
   * 400s instead of ever charging the wrong plan.
   * Returns { url } for the operator to redirect to.
   */
  router.post(
    '/billing/checkout-session',
    requireAuth,
    requireTenant,
    // Owner-only: the route persists a canonical Stripe customer keyed
    // to the requester's email and stamps the per-tenant pending-checkout
    // gate. A dispatcher/tech calling here would bind billing to their
    // email AND lock the owner out of starting checkout for 30 minutes.
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

        const parsed = BillingCheckoutInputSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'A valid plan (basic or enterprise) is required.',
            issues: parsed.error.issues,
          });
          return;
        }

        const tenantId = req.auth!.tenantId;
        const email = await resolveOwnerEmail(req, pool);
        if (!email) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'Owner email not present on auth context',
          });
          return;
        }

        // Where the customer lands after Stripe: the SPA (web origin), never
        // the API host. Resolved once by loadConfig(); see config.publicOrigins.
        const successUrl = publicUrl('web', '/onboarding', { billing: 'ok' });
        const cancelUrl = publicUrl('web', '/onboarding', { billing: 'cancel' });

        const result = await billingService.createTrialCheckoutSession({
          tenantId,
          ownerEmail: email,
          successUrl,
          cancelUrl,
          planId: parsed.data.planId,
        });
        recordFunnelEvent({
          distinctId: req.auth!.userId,
          event: 'plan_selected',
          properties: { tenant_id: tenantId, plan: parsed.data.planId },
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

  /**
   * GET /api/onboarding/voice/presets — the three ElevenLabs preset voices
   * the voice-config step offers.
   */
  router.get('/voice/presets', requireAuth, requireTenant, (_req: AuthenticatedRequest, res: Response) => {
    res.json({ presets: VOICE_PRESETS });
  });

  /**
   * PUT /api/onboarding/voice — feature 4. Persists the chosen voice + greeting
   * and pushes them onto the tenant's Vapi assistant (if one exists). Owner-only
   * (voice config is part of the operator-driven onboarding).
   */
  router.put(
    '/voice',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({ error: 'ONBOARDING_NOT_CONFIGURED', message: 'Voice config requires a database connection' });
          return;
        }
        const parsed = VoiceConfigInputSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const userId = req.auth!.userId;
        const db = currentTenantContext()?.client ?? pool;
        const result = await saveVoiceConfig(
          { pool: db as Pool, auditRepo, vapiClient: deps.vapiClient ?? getVapiClient() },
          {
            tenantId,
            actorId: userId,
            voiceId: parsed.data.voiceId,
            ...(parsed.data.greeting !== undefined ? { greeting: parsed.data.greeting } : {}),
          },
        );
        res.json(result);
      } catch (error: unknown) {
        res.status(500).json({
          error: 'VOICE_CONFIG_SAVE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to save voice config',
        });
      }
    },
  );

  /**
   * POST /api/onboarding/calendar/choose — feature 5. Records the calendar
   * provider chosen in onboarding: 'google' (the client then runs the existing
   * OAuth connect flow) or 'builtin' (the skip path → ServiceOS scheduling).
   * Owner-only.
   */
  router.post(
    '/calendar/choose',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!pool) {
          res.status(503).json({ error: 'ONBOARDING_NOT_CONFIGURED', message: 'Calendar choice requires a database connection' });
          return;
        }
        const parsed = CalendarChoiceInputSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const userId = req.auth!.userId;
        const db = currentTenantContext()?.client ?? pool;
        await db.query(
          `UPDATE tenant_settings SET calendar_provider = $2, updated_at = now() WHERE tenant_id = $1`,
          [tenantId, parsed.data.provider],
        );
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: userId,
            actorRole: 'owner',
            eventType: 'tenant.calendar_provider_set',
            entityType: 'tenant_settings',
            entityId: tenantId,
            metadata: { provider: parsed.data.provider },
          }),
        );
        res.json({ ok: true, calendarProvider: parsed.data.provider });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'CALENDAR_CHOICE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to set calendar provider',
        });
      }
    },
  );

  return router;
}
