import { Router, Request, Response } from 'express';
import { AppConfig } from '../shared/config';
import {
  parseWebhookSecrets,
  verifyWebhookSignatureAny,
  handleWebhookEvent,
  InMemoryWebhookRepository,
  WebhookRepository,
} from './webhook-handler';
import { createLogger } from '../logging/logger';
import { isValidTenantId } from '../db/schema';
import { bootstrapTenant, TenantRepository } from '../auth/clerk';
import { LIFECYCLE_EMAIL_JOB_TYPE } from '../workers/lifecycle-email-worker';
import { SettingsRepository } from '../settings/settings';
import { InvoiceRepository } from '../invoices/invoice';
import { PaymentRepository, recordPayment, PaymentReceiptNotifier, PaymentMethod } from '../invoices/payment';
import {
  recordRefund,
  reversePayment,
  recordFailedPaymentAttempt,
  recordProcessingPayment,
  settleProcessingPayment,
} from '../payments/payment-service';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { CustomerPaymentMethodRepository } from '../payments/customer-payment-method';
import { retrievePaymentMethod } from '../payments/stripe-saved-card';
import { StripeFetch } from '../payments/stripe-payment-intent';
import { JobRepository } from '../jobs/job';
import { PendingInvitationRepository } from '../users/pending-invitation';
import { BillingService } from '../billing/subscription';
import { StripeConnectService } from '../billing/stripe-connect';
import { NotFoundError, ValidationError } from '../shared/errors';
import { Queue } from '../queues/queue';
import {
  DEPROVISION_TENANT_JOB_TYPE,
  type DeprovisionTenantPayload,
} from '../workers/deprovision-tenant';
import { PROVISION_TWILIO_JOB_TYPE, ProvisionTwilioPayload } from '../workers/provision-twilio';
import { VERIFY_AI_JOB_TYPE, type VerifyAiPayload } from '../workers/verify-ai';
import { recordFunnelEvent } from '../analytics/posthog';
import { verifyTwilioSignature, reconstructWebhookUrl } from '../telephony/twilio-signature';
import { handleVapiCallEvent } from '../integrations/vapi/webhook';
import type { SendEmailFn } from '../voice/check-upgrade-nudge';
import { verifySendGridSignature } from './sendgrid-signature';
import { createAuditEvent, AuditRepository } from '../audit/audit';
import { EstimateRepository } from '../estimates/estimate';
import { RefreshJobMoneyStateDeps } from '../jobs/job-money-state';
import { dispatchInboundSms } from '../sms/inbound-dispatch';

const logger = createLogger({ service: 'webhooks', environment: process.env.NODE_ENV || 'dev' });

/**
 * Best-effort mapping from a Stripe payment object to our domain
 * PaymentMethod. Prefers the actual charged method
 * (`charges.data[0].payment_method_details.type`), then the declared
 * `payment_method_types`. ACH / bank-debit variants collapse to
 * 'bank_transfer'; everything else defaults to 'credit_card'. The value is
 * informational (balances don't depend on it), so an unknown shape falling
 * back to 'credit_card' is harmless.
 */
function mapStripePaymentMethod(obj: {
  payment_method_types?: unknown;
  charges?: { data?: Array<{ payment_method_details?: { type?: string } | null } | null> };
}): PaymentMethod {
  const charged = obj.charges?.data?.[0]?.payment_method_details?.type;
  const declared = Array.isArray(obj.payment_method_types)
    ? obj.payment_method_types.filter((t): t is string => typeof t === 'string')
    : [];
  const candidates = [charged, ...declared].filter((t): t is string => typeof t === 'string');
  if (
    candidates.some(
      (t) =>
        t === 'us_bank_account' ||
        t === 'ach_debit' ||
        t === 'acss_debit' ||
        t === 'ach_credit_transfer' ||
        t === 'sepa_debit' ||
        t.includes('bank'),
    )
  ) {
    return 'bank_transfer';
  }
  return 'credit_card';
}

/**
 * Assemble the §6 Time-to-Cash money-state deps when all the required
 * repos are wired; otherwise undefined so recordPayment/reversePayment
 * skip the rollup cleanly. Mirrors the inline shape the
 * checkout.session.completed branch builds.
 */
function buildMoneyStateDeps(deps: WebhookRouterDeps): RefreshJobMoneyStateDeps | undefined {
  if (deps.jobRepo && deps.estimateRepo && deps.invoiceRepo) {
    return {
      jobRepo: deps.jobRepo,
      estimateRepo: deps.estimateRepo,
      invoiceRepo: deps.invoiceRepo,
      auditRepo: deps.auditRepo,
      logger,
    };
  }
  return undefined;
}

export interface WebhookRouterDeps {
  tenantRepo?: TenantRepository;
  settingsRepo?: SettingsRepository;
  invoiceRepo?: InvoiceRepository;
  paymentRepo?: PaymentRepository;
  /**
   * Tier 4 (Deposit rules — PR 3b). When wired, the Stripe webhook
   * branches on `metadata.deposit_for_job_id` to credit
   * `depositPaidCents` on the linked job. Optional so legacy harnesses
   * without the deposit flow keep working.
   */
  jobRepo?: JobRepository;
  /**
   * §6 Time-to-Cash. When wired alongside jobRepo + invoiceRepo, the
   * Stripe checkout webhook rolls the linked job's money-state forward
   * after recording the payment. Optional so legacy harnesses build.
   */
  estimateRepo?: EstimateRepository;
  /**
   * Tier 4 (Team members — PR 3). When wired, the Clerk user.created
   * webhook checks for a pending invitation by email — if one
   * exists, the new user joins THAT tenant instead of bootstrapping
   * a brand-new one. Optional so legacy harnesses keep working.
   */
  pendingInvitationRepo?: PendingInvitationRepository;
  /**
   * Tier 4 (Subscription — Rivet billing). When wired, the Stripe
   * webhook applies customer.subscription.* events onto tenants
   * (cached subscription_status). Optional so legacy harnesses
   * without Stripe configured still build the router.
   */
  billingService?: BillingService;
  /**
   * Tier 4 (Payment methods — PR 1). When wired, the Stripe webhook
   * applies account.updated events onto tenants (cached
   * stripe_connect_charges_enabled / payouts_enabled / status).
   * Optional so legacy harnesses without Connect configured still
   * build the router.
   */
  connectService?: StripeConnectService;
  /**
   * Pg pool for the invitee join-tenant path (writes a users row
   * directly because we don't have an InsertUser repo yet — the
   * existing webhook already uses `pool.query` for similar inline
   * writes). When omitted the join-tenant path is a no-op (legacy
   * fakes that don't track users).
   */
  pool?: import('pg').Pool;
  /**
   * Stripe webhook signing secret(s). Accepts a COMMA-SEPARATED list so both
   * the platform and connected-accounts endpoints (each with its own Stripe
   * secret) can be verified; a single value behaves as before. Parsed by
   * `parseWebhookSecrets`.
   */
  stripeWebhookSecret?: string;
  queue?: Queue;
  appBaseUrl?: string;
  webhookEventRepo?: {
    // `record` carries the existing row on conflict (PgWebhookEventRepository
    // always returns it); optional so lightweight fakes can omit it — an
    // absent record is treated as "not yet processed" (reprocess).
    recordReceipt(provider: string, eventId: string, eventType: string, payload: Record<string, unknown>): Promise<{ inserted: boolean; record?: { processedAt?: Date | null } }>;
    markProcessed(provider: string, eventId: string): Promise<void>;
  };
  auditRepo?: AuditRepository;
  /**
   * #6 phase 4 — when wired, `setup_intent.succeeded` persists the saved
   * PaymentMethod (ids + display metadata) for off-session dues billing.
   * stripeConfig + stripeFetch back the PaymentMethod-details retrieve.
   */
  customerPaymentMethodRepo?: CustomerPaymentMethodRepository;
  stripeConfig?: { apiKey: string };
  stripeFetch?: StripeFetch;
  integrationResolver?: (tenantId: string, provider: 'twilio' | 'sendgrid') => Promise<{
    tenantId: string;
    provider: 'twilio' | 'sendgrid';
    subaccountSid?: string;
    authTokenPrimary?: string;
    authTokenSecondary?: string;
    sendgridPublicKeyPem?: string;
  } | null>;
  /**
   * Resolves a tenant's per-tenant Vapi webhook secret
   * (`tenant_settings.vapi_webhook_secret`) for the `/vapi/:tenantId` handler.
   * Each tenant's assistant is provisioned with its OWN random secret, so a
   * body signed for tenant A fails verification at tenant B (closes the
   * cross-tenant forgery the single global secret allowed). Returns null for a
   * not-yet-provisioned tenant → the handler fails CLOSED (403). The former
   * global `VAPI_WEBHOOK_SECRET` fallback was removed in WS4: a tenant with no
   * per-tenant secret is rejected rather than verified against a shared secret.
   */
  vapiSecretResolver?: (tenantId: string) => Promise<string | null>;
  provisioningQueue?: {
    send<T>(type: string, payload: T, idempotencyKey?: string): Promise<string>;
  };
  /** §7 Layer A — payment receipt SMS/email after Stripe checkout completes. */
  paymentReceiptNotifier?: PaymentReceiptNotifier;
  /** Activation email sender for the Vapi inbound-call webhook. Optional —
   * when absent, activation still fires (funnel event + banner), just no email. */
  sendEmail?: SendEmailFn;
  /**
   * Blocker 1 — durable idempotency store backing the Stripe/Clerk dedup
   * (`handleWebhookEvent`). MUST be supplied in production: the in-memory
   * fallback is wiped on restart and not shared across instances, so
   * Stripe/Clerk retries would re-process (duplicate deposit credit,
   * duplicate tenant bootstrap). `createWebhookRouter` throws in
   * production when this is absent.
   */
  webhookRepo?: WebhookRepository;
}

export function createWebhookRouter(config: AppConfig, deps: WebhookRouterDeps = {}): Router {
  const router = Router();

  // Blocker 1 — Stripe/Clerk webhook idempotency store. Durable (Postgres)
  // in production; falls back to an in-memory map for tests/dev. Fail fast
  // if a production deploy forgot to wire the durable repo rather than
  // silently running with non-durable, per-instance dedup. Guard on the raw
  // env (like app.ts) so an unnormalized 'production' still trips it; the
  // parsed config.NODE_ENV is already narrowed to 'prod' by loadConfig.
  const rawNodeEnv = process.env.NODE_ENV;
  if ((rawNodeEnv === 'prod' || rawNodeEnv === 'production') && !deps.webhookRepo) {
    throw new Error(
      'createWebhookRouter: a durable webhookRepo is required in production ' +
        '(in-memory webhook idempotency is wiped on restart and not shared ' +
        'across instances, allowing duplicate Stripe/Clerk processing)',
    );
  }
  const webhookRepo: WebhookRepository = deps.webhookRepo ?? new InMemoryWebhookRepository();

  /**
   * POST /webhooks/clerk
   *
   * Receives Clerk user lifecycle events (user.created, user.updated, etc.).
   * Clerk signs the payload using svix — we verify with CLERK_WEBHOOK_SECRET.
   *
   * Events handled:
   *   user.created  → bootstrapTenant() to create tenant + set public_metadata
   */
  router.post('/clerk', async (req: Request, res: Response) => {
    const signingSecret = config.CLERK_WEBHOOK_SECRET;

    if (!signingSecret) {
      logger.warn('CLERK_WEBHOOK_SECRET not configured — rejecting webhook');
      return res.status(500).json({ error: 'Webhook not configured' });
    }

    // Svix signature format: svix-id, svix-timestamp, svix-signature headers
    const svixId = req.headers['svix-id'] as string;
    const svixTimestamp = req.headers['svix-timestamp'] as string;
    const svixSignature = req.headers['svix-signature'] as string;

    if (!svixId || !svixTimestamp || !svixSignature) {
      return res.status(400).json({ error: 'Missing svix headers' });
    }

    // QUALITY-2026-07-12 WS4 — replay-window enforcement. Svix signs
    // `${id}.${timestamp}.${body}` and expects verifiers to reject deliveries
    // whose timestamp is outside a tolerance (Svix's own libraries use 5
    // minutes; the Stripe path here already enforces the same). Without this a
    // captured-but-valid signed payload could be replayed indefinitely — the
    // event-id idempotency below only dedups the SAME id, not a fresh capture.
    // Parse as unix seconds; reject malformed / non-integer and > 5-min skew
    // (either direction). Runs BEFORE signature verification so a replayed body
    // is cheap to reject; signature + event-id idempotency below are unchanged.
    const SVIX_TOLERANCE_SECONDS = 300;
    const svixTs = Number(svixTimestamp);
    if (!Number.isInteger(svixTs)) {
      logger.warn('Clerk webhook rejected — malformed svix-timestamp', {
        svixId,
        svixTimestamp,
      });
      return res.status(400).json({ error: 'Invalid svix-timestamp' });
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - svixTs) > SVIX_TOLERANCE_SECONDS) {
      logger.warn('Clerk webhook rejected — timestamp outside tolerance', {
        svixId,
        skewSeconds: nowSeconds - svixTs,
      });
      return res.status(400).json({ error: 'Timestamp outside tolerance' });
    }

    // Verify over the RAW request bytes svix signed. Production mounts
    // express.raw() before the global express.json() for this path, so req.body
    // is a Buffer — verify over those exact bytes rather than re-serializing a
    // parsed object (key order / whitespace / unicode escaping would diverge
    // from the signed bytes and reject legit webhooks, breaking tenant bootstrap
    // on signup). The JSON.stringify fallback only applies when the raw mount is
    // absent (older test harnesses); the production path is always the Buffer.
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : JSON.stringify(req.body);
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;

    // svix-signature contains comma-separated "v1,<base64sig>" values
    // Extract all v1 signatures and check if any match
    const signatures = svixSignature
      .split(' ')
      .map((s) => s.replace(/^v1,/, ''));

    const secret = Buffer.from(signingSecret.replace(/^whsec_/, ''), 'base64');

    const isValid = signatures.some((sig) =>
      (() => { const e = createHmac('sha256', secret).update(signedContent).digest('base64'); const a = Buffer.from(sig); const b = Buffer.from(e); return a.length === b.length && timingSafeEqual(a, b); })()
    );

    if (!isValid) {
      logger.warn('Clerk webhook signature verification failed', { svixId });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Parse the now-verified body. req.body is a Buffer on the raw-mounted
    // production path; a parsed object on the fallback path.
    let payload: Record<string, unknown>;
    if (Buffer.isBuffer(req.body)) {
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    } else {
      payload = req.body as Record<string, unknown>;
    }
    // A literal `null` (or any non-object) is valid JSON that parses without
    // throwing but would crash on the property access below — reject it.
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid or missing payload' });
    }
    const eventType = payload.type as string;

    // Declared outside the try so the catch can mark this row 'failed'
    // (Codex P1 PR #384 — required for Stripe/Clerk retry to actually
    // re-execute, see handleWebhookEvent's dedup logic).
    let webhookEvent: { id: string } | undefined;

    try {
      const result = await handleWebhookEvent(
        'clerk',
        eventType,
        payload,
        svixId,
        webhookRepo
      );
      webhookEvent = result.event;
      const { duplicate } = result;

      if (duplicate) {
        logger.info('Duplicate webhook event — skipping', { svixId, eventType });
        return res.status(200).json({ received: true, duplicate: true });
      }

      // ── Handle specific event types ─────────────────────────────────────────

      if (eventType === 'user.created') {
        const userData = payload.data as Record<string, unknown>;
        const userId = userData.id as string;
        const emailAddresses = userData.email_addresses as Array<{ email_address: string }>;
        const primaryEmail = emailAddresses?.[0]?.email_address;

        logger.info('user.created webhook received', { userId, email: primaryEmail });

        // Tier 4 (Team members — PR 3). Invitation acceptance path.
        // If this user has a pending invitation, JOIN them to the
        // inviting tenant with the invited role rather than
        // bootstrapping a brand-new tenant.
        //
        // Lookup order (PR 319 review P1):
        //   1. By invitation id from Clerk's public_metadata (set by
        //      the invite route) — uniquely identifies the invitation
        //      even if two tenants invited the same email.
        //   2. By email — fallback ONLY when no invitation id was
        //      provided. If an id was present but failed lookup or
        //      sanity-check, we DO NOT fall back to email; that would
        //      reintroduce the cross-tenant ambiguity the id was
        //      meant to resolve (PR 319 review P1). Refusing the
        //      stale/forged id falls through to the bootstrap path,
        //      which is the safe outcome.
        if (deps.pendingInvitationRepo && primaryEmail) {
          const publicMeta = userData.public_metadata as Record<string, unknown> | undefined;
          const invitationId = publicMeta?.invitation_id as string | undefined;
          let pending = null;
          if (invitationId) {
            if (deps.pendingInvitationRepo.findById) {
              pending = await deps.pendingInvitationRepo
                .findById(invitationId)
                .catch(() => null);
              // Sanity check: id-matched invitation MUST also match
              // email (defense against a replay where the metadata
              // is forged). Already-accepted ones are also ignored.
              if (pending && pending.email.toLowerCase() !== primaryEmail.toLowerCase()) {
                logger.warn('Pending invitation id+email mismatch — refusing join', {
                  userId, invitationId, expected: pending.email, got: primaryEmail,
                });
                pending = null;
              }
              if (pending && pending.acceptedAt) pending = null;
            }
            // Deliberately NO email fallback here — see comment above.
          } else {
            // No id present (e.g. a tenant invited without Clerk
            // integration) — email lookup is the only path. The
            // single pending-per-(tenant,email) unique index is the
            // primary defense; same-email-across-tenants remains a
            // known edge in this fallback path.
            pending = await deps.pendingInvitationRepo
              .findPendingByEmail(primaryEmail)
              .catch(() => null);
          }

          if (pending) {
            logger.info('Pending invitation found for new user', {
              userId, email: primaryEmail, tenantId: pending.tenantId, role: pending.role,
              matchedBy: invitationId ? 'id' : 'email',
            });
            try {
              // PR 319 review (P2): only markAccepted AFTER the join
              // write succeeded. Without this guard, a deps.pool=null
              // configuration would consume the invitation without
              // ever inserting the users row, and the invitee would
              // have no access despite Clerk reporting acceptance.
              if (!deps.pool) {
                logger.error('pendingInvitation found but pool not wired — cannot join user', {
                  userId, tenantId: pending.tenantId,
                });
                throw new Error('pool not configured for invitee join');
              }
              // Insert the users row directly. RLS requires the
              // tenant GUC to be set; SET LOCAL only persists inside
              // a transaction (PR 319 review P1), so the BEGIN /
              // COMMIT block is mandatory — without it the SET LOCAL
              // is a no-op and the INSERT fails the RLS policy.
              //
              // The tenantId is also asserted to look like a UUID
              // before being interpolated into the SET LOCAL string
              // (parameterized binding doesn't work for SET names).
              // The id comes from the DB row (FK-backed), so this is
              // belt + suspenders, but explicit prevents a future
              // change from accidentally widening the column.
              const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
              if (!UUID_RE.test(pending.tenantId)) {
                throw new Error(`Invalid tenantId on pending invitation: ${pending.tenantId}`);
              }
              const client = await deps.pool.connect();
              try {
                await client.query('BEGIN');
                await client.query(
                  "SELECT set_config('app.current_tenant_id', $1, true)",
                  [pending.tenantId],
                );
                await client.query(
                  `INSERT INTO users (
                     id, tenant_id, clerk_user_id, email, role,
                     first_name, last_name, created_at, updated_at
                   ) VALUES (
                     gen_random_uuid(), $1, $2, $3, $4,
                     $5, $6, NOW(), NOW()
                   )
                   ON CONFLICT DO NOTHING`,
                  [
                    pending.tenantId,
                    userId,
                    primaryEmail,
                    pending.role,
                    (userData.first_name as string | null) ?? null,
                    (userData.last_name as string | null) ?? null,
                  ],
                );
                await client.query('COMMIT');
              } catch (txErr) {
                await client.query('ROLLBACK').catch(() => undefined);
                throw txErr;
              } finally {
                client.release();
              }
              await deps.pendingInvitationRepo.markAccepted(pending.id);

              // Push tenant_id back to Clerk public_metadata so the
              // JWT carries the right tenant context on the next sign-in.
              if (config.CLERK_SECRET_KEY) {
                try {
                  await fetch(`https://api.clerk.com/v1/users/${userId}`, {
                    method: 'PATCH',
                    headers: {
                      Authorization: `Bearer ${config.CLERK_SECRET_KEY}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      public_metadata: { tenant_id: pending.tenantId, role: pending.role },
                    }),
                    // Bounded: a Clerk stall would otherwise hang this
                    // already-committed webhook while Clerk retries pile up.
                    signal: AbortSignal.timeout(10_000),
                  });
                } catch (err) {
                  logger.error('Clerk public_metadata sync failed (invitee path)', {
                    userId, tenantId: pending.tenantId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }

              if (deps.auditRepo) {
                await deps.auditRepo.create(createAuditEvent({
                  tenantId: pending.tenantId,
                  actorId: userId,
                  actorRole: pending.role,
                  eventType: 'tenant.invitation.accepted',
                  entityType: 'user',
                  entityId: userId,
                  metadata: {
                    invitationId: pending.id,
                    invitedBy: pending.invitedBy,
                    email: primaryEmail,
                  },
                }));
              }

              await webhookRepo.updateStatus(webhookEvent.id, 'processed');
              return res.status(200).json({ received: true, joined: pending.tenantId });
            } catch (joinErr) {
              logger.error('Invitee join failed; failing webhook for Clerk retry', {
                userId, email: primaryEmail, tenantId: pending.tenantId,
                error: joinErr instanceof Error ? joinErr.message : String(joinErr),
              });
              await webhookRepo.updateStatus(webhookEvent.id, 'failed'); return res.status(500).json({ error: 'Invitee join failed' });
              // operator can manually clean up if needed.
            }
          }
        }

        if (deps.tenantRepo && primaryEmail) {
          const result = await bootstrapTenant(userId, primaryEmail, deps.tenantRepo, {
            settingsRepository: deps.settingsRepo,
          });

          const signupCorrelationId = `signup:${svixId}`;
          logger.info('Tenant bootstrap complete', {
            tenantId: result.tenantId,
            created: result.created,
            settingsSeeded: Boolean(deps.settingsRepo),
            signupCorrelationId,
          });

          // Server-side funnel: every Clerk userId here matches the
          // distinctId the browser SDK identifies with, so this single
          // event closes the gap between the page load that fires
          // landing_signup_clicked and the onboarding the user starts.
          if (result.created) {
            recordFunnelEvent({
              distinctId: userId,
              event: 'signup_completed',
              properties: {
                tenantId: result.tenantId,
                emailDomain: primaryEmail.split('@')[1] ?? null,
              },
            });
          }

          // Enqueue Twilio subaccount provisioning for new tenants only.
          // Idempotent — the worker checks tenant_integrations.status and
          // skips if already active, so safe to re-enqueue on webhook replay.
          if (result.created && deps.queue) {
            const region = (userData.unsafe_metadata as Record<string, unknown>)?.region as string | undefined;
            // Twilio callbacks land on the API origin and signatures are
            // verified against PUBLIC_API_URL (see reconstructWebhookUrl in
            // recordTwilio). Prefer that; fall back to appBaseUrl/APP_PUBLIC_URL
            // for single-origin dev/staging deployments.
            const callbackBaseUrl =
              process.env.PUBLIC_API_URL ??
              deps.appBaseUrl ??
              process.env.APP_PUBLIC_URL ??
              'http://localhost:3000';
            const payload: ProvisionTwilioPayload = {
              tenantId: result.tenantId,
              region: region ?? null,
              baseUrl: callbackBaseUrl,
            };
            await deps.queue.send(
              PROVISION_TWILIO_JOB_TYPE,
              payload,
              `provision-twilio-${result.tenantId}`
            );
            logger.info('Twilio provisioning job enqueued', { tenantId: result.tenantId, region });
          }

          // Welcome email — enqueue for brand-new tenants only. The worker
          // claims the lifecycle_emails ledger before sending, so a webhook
          // replay (same idempotency key) never double-sends.
          if (result.created && deps.queue && primaryEmail) {
            try {
              await deps.queue.send(
                LIFECYCLE_EMAIL_JOB_TYPE,
                { tenantId: result.tenantId, ownerEmail: primaryEmail, kind: 'welcome' },
                `lifecycle-welcome-${result.tenantId}`,
              );
              logger.info('Welcome email job enqueued', { tenantId: result.tenantId });
            } catch (err) {
              // Never fail the signup webhook over the welcome email — the
              // tenant is already bootstrapped; the email is best-effort.
              logger.warn('Welcome email enqueue failed', {
                tenantId: result.tenantId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          if (deps.auditRepo) {
            await deps.auditRepo.create(createAuditEvent({
              tenantId: result.tenantId,
              actorId: userId,
              actorRole: 'owner',
              eventType: 'tenant.signup.bootstrap.completed',
              entityType: 'tenant',
              entityId: result.tenantId,
              correlationId: signupCorrelationId,
              metadata: {
                svixId,
                clerkUserId: userId,
                email: primaryEmail,
                created: result.created,
              },
            }));
          }

          if (deps.provisioningQueue && result.created) {
            const queuePayload = {
              tenantId: result.tenantId,
              ownerId: userId,
              ownerEmail: primaryEmail,
              signupCorrelationId,
              webhookEventId: svixId,
            };

            void deps.provisioningQueue.send(
              'tenant.provisioning.root.requested',
              queuePayload,
              `tenant-provisioning:${result.tenantId}`
            ).then(async (queueMessageId) => {
              if (deps.auditRepo) {
                await deps.auditRepo.create(createAuditEvent({
                  tenantId: result.tenantId,
                  actorId: userId,
                  actorRole: 'owner',
                  eventType: 'tenant.signup.provisioning.enqueued',
                  entityType: 'tenant',
                  entityId: result.tenantId,
                  correlationId: signupCorrelationId,
                  metadata: {
                    queueMessageId,
                    queueType: 'tenant.provisioning.root.requested',
                  },
                }));
              }
              logger.info('Root provisioning orchestration enqueued', {
                tenantId: result.tenantId,
                queueMessageId,
                signupCorrelationId,
              });
            }).catch((err) => {
              logger.error('Failed to enqueue root provisioning orchestration', {
                tenantId: result.tenantId,
                signupCorrelationId,
                error: err instanceof Error ? err.message : 'Unknown error',
              });
            });
          }

          // QUALITY-2026-07-12 WS4 (+ PR #669 review) — create the OWNER's
          // membership row. Authorization is DB-authoritative
          // (resolveAuthorization): a caller with no `users` row is rejected,
          // so a bootstrapped owner without this row is locked out of /api.
          // Insert idempotently under the tenant's RLS context (`users` has no
          // unique (tenant_id, clerk_user_id) constraint, so WHERE NOT EXISTS
          // instead of ON CONFLICT — safe on webhook replay).
          //
          // A failure here RETHROWS and fails the webhook (500 → Clerk
          // retries; the catch below marks the event 'failed' so dedup lets
          // the retry re-execute). That is safe BECAUSE this block runs AFTER
          // every `result.created`-gated side effect above: on the retry,
          // created=false skips the already-done funnel/Twilio/welcome/
          // provisioning work and this idempotent insert simply re-attempts.
          // Logging-only was the previous behavior and left the owner locked
          // out with no retry (Clerk got a 200). Migration 249 backfills any
          // rows missed before this change.
          if (deps.pool) {
            const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (UUID_RE.test(result.tenantId)) {
              const ownerClient = await deps.pool.connect();
              try {
                await ownerClient.query('BEGIN');
                await ownerClient.query(
                  "SELECT set_config('app.current_tenant_id', $1, true)",
                  [result.tenantId],
                );
                await ownerClient.query(
                  `INSERT INTO users (
                     id, tenant_id, clerk_user_id, email, role,
                     first_name, last_name, created_at, updated_at
                   )
                   SELECT gen_random_uuid(), $1, $2, $3, 'owner', $4, $5, NOW(), NOW()
                   WHERE NOT EXISTS (
                     SELECT 1 FROM users WHERE tenant_id = $1 AND clerk_user_id = $2
                   )`,
                  [
                    result.tenantId,
                    userId,
                    primaryEmail,
                    (userData.first_name as string | null) ?? null,
                    (userData.last_name as string | null) ?? null,
                  ],
                );
                await ownerClient.query('COMMIT');
              } catch (ownerErr) {
                await ownerClient.query('ROLLBACK').catch(() => undefined);
                logger.error('Owner users-row insert failed — failing webhook so Clerk retries', {
                  tenantId: result.tenantId,
                  userId,
                  error: ownerErr instanceof Error ? ownerErr.message : String(ownerErr),
                });
                throw ownerErr;
              } finally {
                ownerClient.release();
              }
            }
          }

          // Write tenant_id back to Clerk user's public_metadata (best-effort)
          if (config.CLERK_SECRET_KEY) {
            try {
              const clerkRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
                method: 'PATCH',
                headers: {
                  'Authorization': `Bearer ${config.CLERK_SECRET_KEY}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  public_metadata: { tenant_id: result.tenantId, role: 'owner' },
                }),
                // Bounded like the invitee-path sync above.
                signal: AbortSignal.timeout(10_000),
              });
              if (!clerkRes.ok) {
                const errBody = await clerkRes.text();
                logger.error('Failed to update Clerk user metadata', {
                  userId, tenantId: result.tenantId, status: clerkRes.status, body: errBody,
                });
              } else {
                logger.info('Clerk user metadata updated with tenant_id', {
                  userId, tenantId: result.tenantId,
                });
              }
            } catch (err) {
              logger.error('Clerk API call failed', {
                userId, tenantId: result.tenantId,
                error: err instanceof Error ? err.message : 'Unknown error',
              });
            }
          }
        } else if (!deps.tenantRepo) {
          logger.warn('No tenant repository configured — skipping tenant bootstrap');
        }
      }

      // ── 16D — user.deleted: soft-delete the users row; preserve all data ──
      //
      // Per QA 16.22: subsequent API requests with the deleted user's token
      // must return 401. Clerk invalidates the JWT immediately on deletion so
      // verifyRs256Token in the auth middleware handles that automatically.
      // Our job here is to stamp deleted_at on the users row (migration 093)
      // and emit an audit event.
      //
      // Per QA 16.23: tenant data in Postgres MUST NOT be purged — it is
      // retained for audit and billing until an explicit purge is requested
      // by the ops team (manual deprovisioning).
      //
      // Per QA 16.24: the tenant's Twilio subaccount MUST NOT be released
      // automatically — releasing a number could redirect calls intended for
      // the original tenant to a new assignee. Manual deprovisioning must
      // include an explicit Twilio subaccount suspend/close step.
      if (eventType === 'user.deleted') {
        const userData = payload.data as Record<string, unknown>;
        const userId = userData.id as string;

        logger.info('user.deleted webhook received — soft-deleting users row', { userId });

        if (deps.pool) {
          try {
            // The users table has RLS on tenant_id, but here we need to delete
            // by clerk_user_id across whatever tenant the user belonged to.
            // We use the system-level pattern (no SET LOCAL) with an explicit
            // WHERE on clerk_user_id. The UPDATE only touches the matched row,
            // so cross-tenant leakage is not possible.
            // mobile_number is cleared for the same reason softDeleteSelf
            // (pg-user.ts) clears it: deleted rows are hidden from reads and
            // rejected by writes, so a retained number would hold its
            // users_mobile_unique slot forever with no API escape hatch.
            const result = await deps.pool.query<{ id: string; tenant_id: string }>(
              `UPDATE users
               SET deleted_at = NOW(), mobile_number = NULL, updated_at = NOW()
               WHERE clerk_user_id = $1 AND deleted_at IS NULL
               RETURNING id, tenant_id`,
              [userId],
            );
            const deletedRows = result.rows;
            if (deletedRows.length > 0) {
              logger.info('user.deleted: users row soft-deleted', {
                userId,
                affectedRows: deletedRows.length,
                tenantId: deletedRows[0]?.tenant_id,
              });

              if (deps.auditRepo) {
                for (const row of deletedRows) {
                  await deps.auditRepo.create(createAuditEvent({
                    tenantId: row.tenant_id,
                    actorId: 'system:clerk_webhook',
                    actorRole: 'system',
                    eventType: 'user.deleted',
                    entityType: 'user',
                    entityId: row.id,
                    metadata: {
                      clerkUserId: userId,
                      svixId,
                      note: 'User row soft-deleted. Tenant data and Twilio subaccount intentionally retained — manual deprovisioning required.',
                    },
                  }));
                }
              }
            } else {
              logger.info('user.deleted: no users row found for clerk_user_id', { userId });
            }
          } catch (deleteErr) {
            logger.error('user.deleted: soft-delete failed', {
              userId,
              error: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
            });
            // Do not rethrow — a failed soft-delete should not cause the
            // webhook to 500 (Clerk would retry indefinitely). The user's
            // JWT is already invalidated by Clerk regardless.
          }
        } else {
          logger.warn('user.deleted: pool not configured — skipping soft-delete', { userId });
        }
      }

      await webhookRepo.updateStatus(webhookEvent.id, 'processed');
      return res.status(200).json({ received: true });

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Webhook processing failed', { svixId, eventType, error: message });
      if (webhookEvent) {
        await webhookRepo.updateStatus(webhookEvent.id, 'failed', message);
      }
      return res.status(500).json({ error: 'Processing failed' });
    }
  });

  /**
   * POST /webhooks/stripe
   *
   * Receives Stripe events for payment processing. Stripe signs the raw body
   * with HMAC-SHA256 — the route is mounted with express.raw() BEFORE the
   * global express.json() middleware so req.body is a Buffer here.
   *
   * Events handled:
   *   checkout.session.completed → recordPayment() to mark invoice paid
   */
  router.post('/stripe', async (req: Request, res: Response) => {
    // STRIPE_WEBHOOK_SECRET may hold MULTIPLE secrets (comma-separated) — one
    // per Stripe endpoint. Full Connect coverage needs a platform-scoped and a
    // connected-accounts-scoped endpoint, and Stripe issues a distinct secret
    // per endpoint, so we verify against each. A single value is unchanged.
    const secrets = parseWebhookSecrets(deps.stripeWebhookSecret);
    if (secrets.length === 0) {
      logger.warn('STRIPE_WEBHOOK_SECRET not configured — rejecting Stripe webhook');
      return res.status(500).json({ error: 'Stripe webhook not configured' });
    }

    const signatureHeader = req.headers['stripe-signature'] as string | undefined;
    if (!signatureHeader) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    // req.body is a Buffer when express.raw() is mounted before express.json().
    // Coerce to string for signature verification; do NOT re-serialize a parsed
    // object (key order changes → signature mismatch).
    const rawBodyStr: string = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : (() => { throw new Error('Body pre-parsed; mount /webhooks/stripe before express.json()'); })();

    // Re-use the existing verify utility — handles timing-safe comparison and
    // the 5-minute timestamp tolerance — trying each configured secret so an
    // event from either the platform or connected-accounts endpoint verifies.
    if (!verifyWebhookSignatureAny(rawBodyStr, signatureHeader, secrets)) {
      logger.warn('Stripe webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let event: { id: string; type: string; data: { object: Record<string, unknown> } };
    try {
      event = JSON.parse(rawBodyStr);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // Idempotency guard: reject replays and concurrent deliveries of the same
    // Stripe event. webhookRepo is a module-level singleton so the dedup map
    // persists across requests. Uses the existing handleWebhookEvent() pattern.
    // Codex P1 (PR #384) — capture the WebhookEvent's internal UUID
    // (webhookEvent.id) for status-update calls. Previously the route
    // used `event.id` (the SHADOWED Stripe event id from JSON.parse
    // above), which the id-keyed updateStatus silently no-op'd, so rows
    // stayed at status='received' and our new status-aware dedup re-ran
    // the handler on retries.
    const { event: webhookEvent, duplicate } = await handleWebhookEvent(
      'stripe',
      event.type,
      event.data as Record<string, unknown>,
      event.id,
      webhookRepo,
    );
    if (duplicate) {
      logger.info('Duplicate Stripe event — skipping', { eventId: event.id, type: event.type });
      return res.status(200).json({ received: true, duplicate: true });
    }

    logger.info('Stripe webhook received', { eventId: event.id, type: event.type });

    try {
      // #6 phase 4 — a customer saved a card on file. Persist the resulting
      // PaymentMethod (ids + display metadata) so the dues sweep can charge it
      // off-session. The PM lives on the connected account the event came from
      // (event.account); we retrieve its card metadata there. Idempotent: a
      // replay finds the row already stored and no-ops.
      if (event.type === 'setup_intent.succeeded') {
        const si = event.data.object as {
          customer?: string;
          payment_method?: string;
          metadata?: { tenant_id?: string; customer_id?: string };
        };
        const siTenantId = si.metadata?.tenant_id;
        const siCustomerId = si.metadata?.customer_id;
        if (
          deps.customerPaymentMethodRepo &&
          deps.stripeConfig &&
          siTenantId &&
          siCustomerId &&
          si.customer &&
          si.payment_method
        ) {
          const already = await deps.customerPaymentMethodRepo.findByStripePaymentMethodId(
            siTenantId,
            si.payment_method,
          );
          if (!already) {
            const connectedAccountId = (event as { account?: string }).account;
            let brand: string | undefined;
            let last4: string | undefined;
            let expMonth: number | undefined;
            let expYear: number | undefined;
            try {
              const details = await retrievePaymentMethod(
                { apiKey: deps.stripeConfig.apiKey, stripeAccountId: connectedAccountId },
                si.payment_method,
                deps.stripeFetch,
              );
              ({ brand, last4, expMonth, expYear } = details);
            } catch (retrieveErr) {
              // Non-fatal: store the ids now; display metadata is cosmetic.
              logger.warn('setup_intent.succeeded: payment-method retrieve failed', {
                error: retrieveErr instanceof Error ? retrieveErr.message : String(retrieveErr),
              });
            }
            // First saved card becomes the default for auto-collection.
            const existingDefault = await deps.customerPaymentMethodRepo.findDefaultForCustomer(
              siTenantId,
              siCustomerId,
            );
            await deps.customerPaymentMethodRepo.create({
              id: randomUUID(),
              tenantId: siTenantId,
              customerId: siCustomerId,
              stripeCustomerId: si.customer,
              stripePaymentMethodId: si.payment_method,
              // The account the card lives on (connected account, or undefined
              // for platform). The dues charge later targets exactly this.
              stripeAccountId: connectedAccountId,
              brand,
              last4,
              expMonth,
              expYear,
              isDefault: !existingDefault,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            logger.info('Saved customer payment method from setup_intent.succeeded', {
              tenantId: siTenantId,
            });
          }
        }
        await webhookRepo.updateStatus(webhookEvent.id, 'processed');
        return res.status(200).json({ received: true });
      }

      // Trial-checkout marker clear on the ABANDONED path only.
      // checkout.session.expired fires when the session times out
      // without completion or when /v1/checkout/sessions/:id/expire
      // runs from clearPendingCheckout — no subscription will arrive
      // for this session, so the marker can clear immediately.
      //
      // We do NOT clear on checkout.session.completed: that event
      // can be delivered BEFORE customer.subscription.created, and
      // clearing here would reopen the gate while subscription_status
      // is still null, letting the operator mint a SECOND completable
      // session in the gap. The subscription.created branch below
      // does the clear once subscription_status is actually live.
      if (event.type === 'checkout.session.expired') {
        const expiredSessionId = (event.data.object as { id?: string }).id;
        if (expiredSessionId && deps.pool) {
          await deps.pool.query(
            `UPDATE tenants
                SET pending_checkout_at = NULL,
                    pending_checkout_session_id = NULL,
                    updated_at = NOW()
              WHERE pending_checkout_session_id = $1`,
            [expiredSessionId],
          );
        }
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as {
          metadata?: {
            tenant_id?: string;
            invoice_id?: string;
            // Tier 4 (Deposit rules — PR 3b). When set, the session is
            // a deposit collection rather than an invoice payment. The
            // two metadata keys are mutually exclusive — public-estimate
            // mints links with deposit_for_job_id only.
            deposit_for_job_id?: string;
          };
          amount_total?: number;
          payment_status?: string;
          // D2-4 (Codex P1 #2) — Stripe returns payment_intent as a
          // string by default; if the session was retrieved with
          // expand=['payment_intent'] it becomes an object. We stamp
          // the id (string) into the local payment's
          // `provider_reference` so the later `charge.refunded`
          // handler can resolve the payment row from the refund's
          // `payment_intent` field.
          payment_intent?: string | { id?: string };
        };

        // Only process fully-paid sessions. For ACH/bank transfers, Stripe can
        // fire checkout.session.completed with payment_status='unpaid' before
        // funds clear — skip those and wait for the subsequent payment event.
        if (session.payment_status !== 'paid') {
          logger.info('Skipping incomplete Stripe checkout session', {
            eventId: event.id, paymentStatus: session.payment_status,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        const tenantId = session.metadata?.tenant_id;
        const invoiceId = session.metadata?.invoice_id;
        const depositForJobId = session.metadata?.deposit_for_job_id;
        const amountTotal = session.amount_total; // already in cents

        // Tier 4 (Deposit rules — PR 3b). Deposit branch: credit
        // depositPaidCents on the linked job. Cap at depositRequiredCents
        // (the DB CHECK enforces the same bound) so an over-tap doesn't
        // wedge the job row. Idempotency comes from the outer
        // handleWebhookEvent dedup; a duplicate delivery would already
        // have returned `duplicate: true` above.
        if (depositForJobId && tenantId && amountTotal && amountTotal > 0) {
          if (!deps.jobRepo) {
            logger.error('Job repo not wired to Stripe webhook handler');
            return res.status(500).json({ error: 'Deposit processing not configured' });
          }
          const job = await deps.jobRepo.findById(tenantId, depositForJobId);
          if (!job) {
            logger.warn('Deposit checkout for unknown job', {
              eventId: event.id, tenantId, depositForJobId,
            });
            await webhookRepo.updateStatus(webhookEvent.id, 'processed');
            return res.status(200).json({ received: true, skipped: true });
          }
          const required = job.depositRequiredCents ?? 0;
          const previouslyPaid = job.depositPaidCents ?? 0;
          if (required <= 0) {
            logger.warn('Deposit paid for job with no required deposit', {
              eventId: event.id, tenantId, depositForJobId,
            });
            await webhookRepo.updateStatus(webhookEvent.id, 'processed');
            return res.status(200).json({ received: true, skipped: true });
          }
          // Atomic credit: two distinct checkout.session.completed events for
          // the same job (e.g. a double-tapped "Pay Deposit" minting two
          // sessions) must both count. The old read-then-blind-set dropped one.
          const credited = await deps.jobRepo.creditDepositAtomic(
            tenantId,
            depositForJobId,
            amountTotal,
            new Date(),
          );
          const newPaid = credited?.depositPaidCents ?? previouslyPaid;
          logger.info('Deposit credited via Stripe checkout', {
            tenantId, depositForJobId, amountTotal, newPaid, required,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, deposit: true });
        }

        if (!tenantId || !invoiceId || !amountTotal || amountTotal <= 0) {
          logger.warn('Stripe checkout.session.completed missing or invalid metadata', {
            eventId: event.id, tenantId, invoiceId, amountTotal,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        if (!deps.invoiceRepo || !deps.paymentRepo) {
          logger.error('Invoice/payment repos not wired to Stripe webhook handler');
          return res.status(500).json({ error: 'Payment processing not configured' });
        }

        // D2-4 (Codex P1 #2) — stamp the Stripe payment_intent id into
        // `providerReference` so `charge.refunded` can resolve back to
        // this payment via `paymentRepo.findByProviderReference`. Our
        // Stripe creation paths attach tenant_id+invoice_id metadata
        // but NEVER payment_id, so without this the refund handler had
        // no way to find the originating row and silently ACKed every
        // real refund as 'skipped'. Fall back to the previous literal
        // for the edge case where payment_intent is absent (preserves
        // legacy behavior for any pre-existing fixtures).
        const paymentIntentRef: string =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (typeof session.payment_intent === 'object' &&
                session.payment_intent !== null &&
                typeof session.payment_intent.id === 'string')
              ? session.payment_intent.id
              : 'stripe_checkout';

        // §6 Time-to-Cash. Refresh deps for the post-payment job
        // money-state rollup. Undefined unless all three repos are
        // wired — recordPayment then skips the rollup cleanly.
        const moneyStateDeps: RefreshJobMoneyStateDeps | undefined =
          deps.jobRepo && deps.estimateRepo
            ? {
                jobRepo: deps.jobRepo,
                estimateRepo: deps.estimateRepo,
                invoiceRepo: deps.invoiceRepo,
                auditRepo: deps.auditRepo,
                logger,
              }
            : undefined;

        try {
          await recordPayment(
            {
              tenantId,
              invoiceId,
              amountCents: amountTotal,
              method: 'credit_card',
              providerReference: paymentIntentRef,
              processedBy: 'stripe_webhook',
            },
            deps.invoiceRepo,
            deps.paymentRepo,
            moneyStateDeps,
            deps.paymentReceiptNotifier,
            deps.auditRepo,
            { actorRole: 'system', correlationId: paymentIntentRef },
          );
          logger.info('Invoice marked paid via Stripe checkout', { tenantId, invoiceId, amountTotal });
        } catch (payErr) {
          if (payErr instanceof ValidationError) {
            if (payErr.message.includes('exceeds amount due')) {
              // Overpayment: cap to whatever is still owed and retry.
              const invoice = await deps.invoiceRepo.findById(tenantId, invoiceId);
              if (!invoice || invoice.amountDueCents <= 0) {
                logger.info('Invoice already fully paid (overpayment scenario)', { tenantId, invoiceId });
              } else {
                await recordPayment(
                  {
                    tenantId,
                    invoiceId,
                    amountCents: invoice.amountDueCents,
                    method: 'credit_card',
                    providerReference: paymentIntentRef,
                    processedBy: 'stripe_webhook',
                  },
                  deps.invoiceRepo,
                  deps.paymentRepo,
                  moneyStateDeps,
                  deps.paymentReceiptNotifier,
                  deps.auditRepo,
                  { actorRole: 'system', correlationId: paymentIntentRef },
                );
                logger.info('Invoice paid at capped amount', {
                  tenantId, invoiceId, requested: amountTotal, paid: invoice.amountDueCents,
                });
              }
            } else if (payErr.message.includes('status')) {
              // Invoice already settled (paid/void/canceled) — idempotent success.
              logger.info('Invoice already settled, ignoring Stripe payment', { tenantId, invoiceId });
            } else {
              throw payErr;
            }
          } else {
            throw payErr;
          }
        }
      }

      // U5 (ACH async lifecycle) — bank debit INITIATED. Stripe fires
      // `payment_intent.processing` when an ACH / us_bank_account debit is
      // submitted but funds have not cleared (settlement takes days). We
      // record an IN-FLIGHT payment ('processing') and credit the invoice
      // balance now so the owner / AR / digest aren't blind to days-long
      // settlement — while gross-revenue math (status === 'completed')
      // still excludes it. The later payment_intent.succeeded settles it
      // (no re-credit); a payment_intent.payment_failed / ACH return backs
      // out this credit and reopens the invoice.
      //
      // Idempotent: a payment row already existing for this PI (processing
      // OR completed) means we've already credited — skip. The outer
      // webhook-event-id dedup is the second line of defense.
      if (event.type === 'payment_intent.processing') {
        const pi = event.data.object as {
          id?: string;
          amount?: number;
          amount_received?: number;
          metadata?: { tenant_id?: string; invoice_id?: string };
          payment_method_types?: unknown;
          charges?: { data?: Array<{ payment_method_details?: { type?: string } | null } | null> };
        };

        const tenantId = pi.metadata?.tenant_id;
        const invoiceId = pi.metadata?.invoice_id;
        const piId = pi.id;
        // For an initiated debit the funds haven't arrived, so
        // `amount_received` is 0 — the to-be-credited amount is `amount`.
        const amountCents = pi.amount ?? pi.amount_received;

        if (!tenantId || !invoiceId || !piId || !amountCents || amountCents <= 0) {
          logger.info('payment_intent.processing missing invoice metadata — skipping', {
            eventId: event.id, paymentIntentId: piId,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        if (!deps.invoiceRepo || !deps.paymentRepo) {
          logger.error('Invoice/payment repos not wired to Stripe webhook handler');
          return res.status(500).json({ error: 'Payment processing not configured' });
        }

        const existing = await deps.paymentRepo.findByProviderReference(tenantId, piId);
        if (existing && (existing.status === 'processing' || existing.status === 'completed')) {
          logger.info('payment_intent.processing already recorded — skipping', {
            tenantId, invoiceId, paymentIntentId: piId, status: existing.status,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, duplicate: true });
        }

        try {
          await recordProcessingPayment(
            {
              tenantId,
              invoiceId,
              amountCents,
              method: mapStripePaymentMethod(pi),
              providerReference: piId,
              processedBy: 'stripe_webhook',
            },
            deps.invoiceRepo,
            deps.paymentRepo,
            buildMoneyStateDeps(deps),
            deps.auditRepo,
            { actorRole: 'system', correlationId: piId },
          );
          logger.info('Recorded in-flight ACH payment via payment_intent.processing', {
            tenantId, invoiceId, amountCents, paymentIntentId: piId,
          });
        } catch (payErr) {
          if (
            payErr instanceof ValidationError &&
            (payErr.message.includes('status') ||
              payErr.message.includes('already fully paid'))
          ) {
            // Invoice already settled (e.g. a prior card payment cleared
            // it first) — nothing to credit in-flight. Idempotent success.
            logger.info('Invoice not creditable, ignoring payment_intent.processing', {
              tenantId, invoiceId,
            });
          } else {
            throw payErr;
          }
        }
      }

      // Invoice-to-cash — async (ACH/bank) settlement success. The
      // checkout.session.completed branch SKIPS sessions with
      // payment_status != 'paid' (bank debits clear later), so for ACH
      // THIS event is what finally marks the invoice paid. For CARD
      // payments this event also fires, but checkout.session.completed
      // already recorded the payment (stamping the PI id into
      // provider_reference) — so we dedup on that completed row to avoid
      // double-recording.
      //
      // U5 (ACH async lifecycle): when payment_intent.processing already
      // recorded an IN-FLIGHT row for this PI, we SETTLE it (flip
      // 'processing' -> 'completed') WITHOUT re-crediting the invoice —
      // the credit was applied at processing time. Only a PI with no
      // existing row falls through to recordPayment (the card / first-time
      // path).
      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object as {
          id?: string;
          amount?: number;
          amount_received?: number;
          metadata?: { tenant_id?: string; invoice_id?: string };
          payment_method_types?: unknown;
          charges?: { data?: Array<{ payment_method_details?: { type?: string } | null } | null> };
        };

        const tenantId = pi.metadata?.tenant_id;
        const invoiceId = pi.metadata?.invoice_id;
        const piId = pi.id;
        const amountCents = pi.amount_received ?? pi.amount;

        if (!tenantId || !invoiceId || !piId || !amountCents || amountCents <= 0) {
          logger.info('payment_intent.succeeded missing invoice metadata — skipping', {
            eventId: event.id, paymentIntentId: piId,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        if (!deps.invoiceRepo || !deps.paymentRepo) {
          logger.error('Invoice/payment repos not wired to Stripe webhook handler');
          return res.status(500).json({ error: 'Payment processing not configured' });
        }

        const existing = await deps.paymentRepo.findByProviderReference(tenantId, piId);
        if (existing && existing.status === 'completed') {
          logger.info('payment_intent.succeeded already recorded — skipping', {
            tenantId, invoiceId, paymentIntentId: piId,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, duplicate: true });
        }

        // U5 (ACH async lifecycle) — an IN-FLIGHT row exists (recorded at
        // payment_intent.processing). SETTLE it: flip 'processing' ->
        // 'completed' WITHOUT re-crediting the invoice (the credit was
        // applied at processing time). settleProcessingPayment is atomic +
        // idempotent, so a duplicate succeeded is a clean no-op.
        if (existing && existing.status === 'processing') {
          const result = await settleProcessingPayment(
            {
              tenantId,
              paymentId: existing.id,
              correlationId: piId,
            },
            deps.paymentRepo,
            deps.auditRepo,
          );
          logger.info('Settled in-flight ACH payment via payment_intent.succeeded', {
            tenantId, invoiceId, paymentIntentId: piId, settled: result.settled,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, settled: result.settled });
        }

        try {
          await recordPayment(
            {
              tenantId,
              invoiceId,
              amountCents,
              method: mapStripePaymentMethod(pi),
              providerReference: piId,
              processedBy: 'stripe_webhook',
            },
            deps.invoiceRepo,
            deps.paymentRepo,
            buildMoneyStateDeps(deps),
            deps.paymentReceiptNotifier,
            deps.auditRepo,
            { actorRole: 'system', correlationId: piId },
          );
          logger.info('Invoice marked paid via payment_intent.succeeded (async settlement)', {
            tenantId, invoiceId, amountCents, paymentIntentId: piId,
          });
        } catch (payErr) {
          if (
            payErr instanceof ValidationError &&
            (payErr.message.includes('status') || payErr.message.includes('exceeds amount due'))
          ) {
            // Invoice already settled (e.g. checkout.session.completed used
            // the 'stripe_checkout' provider_reference fallback so the dedup
            // above missed) — idempotent success.
            logger.info('Invoice already settled, ignoring payment_intent.succeeded', {
              tenantId, invoiceId,
            });
          } else {
            throw payErr;
          }
        }
      }

      // Invoice-to-cash — payment failure. Unifies two cases by whether
      // money was previously recorded for this payment_intent:
      //   (a) a COMPLETED payment exists -> POST-SETTLEMENT failure: an
      //       ACH/bank debit RETURNED for insufficient funds (NSF) days
      //       after it appeared to settle. Reverse it, reopening the
      //       invoice so it re-enters collections.
      //   (b) otherwise -> a plain DECLINE (no money ever captured):
      //       record a 'failed' attempt for visibility; the invoice
      //       balance is untouched (it was never paid).
      if (event.type === 'payment_intent.payment_failed') {
        const pi = event.data.object as {
          id?: string;
          amount?: number;
          metadata?: { tenant_id?: string; invoice_id?: string };
          payment_method_types?: unknown;
          charges?: { data?: Array<{ payment_method_details?: { type?: string } | null } | null> };
          last_payment_error?: { code?: string; message?: string; decline_code?: string };
        };

        const tenantId = pi.metadata?.tenant_id;
        const invoiceId = pi.metadata?.invoice_id;
        const piId = pi.id;

        if (!tenantId || !invoiceId || !piId) {
          logger.info('payment_intent.payment_failed missing invoice metadata — skipping', {
            eventId: event.id, paymentIntentId: piId,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        if (!deps.invoiceRepo || !deps.paymentRepo) {
          logger.error('Invoice/payment repos not wired to Stripe webhook handler');
          return res.status(500).json({ error: 'Payment processing not configured' });
        }

        const reasonText =
          pi.last_payment_error?.decline_code ??
          pi.last_payment_error?.code ??
          pi.last_payment_error?.message;

        const existing = await deps.paymentRepo.findByProviderReference(tenantId, piId);

        if (existing && (existing.status === 'completed' || existing.status === 'processing')) {
          // ACH return / NSF. Two shapes, one effect (reverse the credit +
          // reopen the invoice), routed by reversePayment:
          //   - 'completed' -> POST-SETTLEMENT failure: the debit appeared
          //     to clear, then the bank pulled it back days later.
          //   - 'processing' (U5) -> the IN-FLIGHT debit was returned
          //     BEFORE it ever settled; back out the in-flight credit.
          // reversePayment tries the completed-guarded flip first, then the
          // in-flight ('processing') flip — both idempotent.
          await reversePayment(
            {
              tenantId,
              paymentId: existing.id,
              reason: 'ach_return',
              correlationId: piId,
            },
            deps.invoiceRepo,
            deps.paymentRepo,
            deps.auditRepo,
            buildMoneyStateDeps(deps),
          );
          logger.warn('Payment reversed via payment_intent.payment_failed (ACH return/NSF)', {
            tenantId, invoiceId, paymentId: existing.id, paymentIntentId: piId,
            priorStatus: existing.status, reason: reasonText,
          });
        } else if (existing && existing.reversedAt) {
          // Already reversed by a prior delivery — no-op.
          logger.info('payment_intent.payment_failed for already-reversed payment — skipping', {
            tenantId, invoiceId, paymentIntentId: piId,
          });
        } else {
          await recordFailedPaymentAttempt(
            {
              tenantId,
              invoiceId,
              amountCents: pi.amount ?? 0,
              method: mapStripePaymentMethod(pi),
              providerReference: piId,
              reason: reasonText,
            },
            deps.paymentRepo,
            deps.auditRepo,
          );
          logger.info('Recorded failed payment attempt (declined)', {
            tenantId, invoiceId, paymentIntentId: piId, reason: reasonText,
          });
        }
      }

      // Tier 4 (Subscription — Rivet billing). customer.subscription.*
      // events update the tenant's cached subscription status. Match
      // by stripe_customer_id (the BillingService persists it on
      // first portal-open). Idempotent — we just write the latest
      // snapshot. created/updated/deleted all share the same handler;
      // 'deleted' typically arrives with status='canceled' so the
      // mirror naturally reflects the lifecycle end.
      if (
        deps.billingService &&
        (event.type === 'customer.subscription.created' ||
          event.type === 'customer.subscription.updated' ||
          event.type === 'customer.subscription.deleted')
      ) {
        const sub = event.data.object as {
          id?: string;
          customer?: string;
          status?: string;
          trial_end?: number | null;
          metadata?: { tenant_id?: string };
        };
        if (sub.id && sub.customer && sub.status) {
          // Mirror the Stripe trial_end (epoch seconds) into trial_ends_at so
          // the trial-reminder sweep can compute the 3d/1d/day-of windows. When
          // the trial converts to active, Stripe drops trial_end → null, which
          // clears our cached value and stops the sweep.
          const trialEndsAt =
            typeof sub.trial_end === 'number' ? new Date(sub.trial_end * 1000) : null;
          // Trial-checkout sessions stamp subscription.metadata.tenant_id
          // (see createTrialCheckoutSession), but Stripe doesn't echo our
          // tenants.stripe_customer_id back to us — so for a brand-new
          // trial subscription, the WHERE stripe_customer_id = $customer
          // lookup below returns zero rows, applySubscriptionEvent is a
          // silent no-op, and the funnel event never fires. Resolve the
          // tenant by metadata first when present, fall back to the
          // persisted customer-id mapping for billing-portal-managed
          // subscriptions where the trial metadata wasn't set.
          const tenantIdFromMeta = sub.metadata?.tenant_id?.trim() || null;

          let priorStatus: string | null = null;
          let ownerClerkId: string | null = null;
          let funnelTenantId: string | null = null;

          if (deps.pool) {
            // The entire read + mirror happens inside a transaction
            // with SELECT ... FOR UPDATE on the tenants row so two
            // concurrent webhook events for the same transition
            // (e.g. customer.subscription.created AND a
            // customer.subscription.updated both reporting trialing)
            // serialize through this critical section. The second
            // handler reads the FIRST handler's just-committed
            // subscription_status, so the funnel-event check
            // (priorStatus !== 'trialing') correctly returns false
            // for it — closing the double-fire race that the prior
            // commit only documented.
            const client = await deps.pool.connect();
            try {
              await client.query('BEGIN');
              const tenantRow = tenantIdFromMeta
                ? await client.query<{
                    id: string;
                    owner_id: string | null;
                    subscription_status: string | null;
                    stripe_customer_id: string | null;
                  }>(
                    `SELECT id, owner_id, subscription_status, stripe_customer_id
                       FROM tenants WHERE id = $1 LIMIT 1
                       FOR UPDATE`,
                    [tenantIdFromMeta],
                  )
                : await client.query<{
                    id: string;
                    owner_id: string | null;
                    subscription_status: string | null;
                    stripe_customer_id: string | null;
                  }>(
                    `SELECT id, owner_id, subscription_status, stripe_customer_id
                       FROM tenants WHERE stripe_customer_id = $1 LIMIT 1
                       FOR UPDATE`,
                    [sub.customer],
                  );
              const row = tenantRow.rows[0];
              if (row) {
                funnelTenantId = row.id;
                ownerClerkId = row.owner_id;
                priorStatus = row.subscription_status;
                // Claim the Stripe customer for this tenant on first
                // sight. Idempotent — only writes when the column is
                // null, never clobbers an existing mapping.
                if (!row.stripe_customer_id) {
                  await client.query(
                    `UPDATE tenants
                        SET stripe_customer_id = $1, updated_at = NOW()
                      WHERE id = $2 AND stripe_customer_id IS NULL`,
                    [sub.customer, row.id],
                  );
                }
                // Clear the pending-checkout marker only on
                // customer.subscription.created (see prior commit for
                // the full rationale on why created vs. completed
                // is the right surface).
                if (event.type === 'customer.subscription.created') {
                  await client.query(
                    `UPDATE tenants
                        SET pending_checkout_at = NULL,
                            pending_checkout_session_id = NULL,
                            updated_at = NOW()
                      WHERE id = $1
                        AND (pending_checkout_at IS NOT NULL OR pending_checkout_session_id IS NOT NULL)`,
                    [row.id],
                  );
                }
                // Mirror the subscription state INSIDE the lock.
                // Replaces deps.billingService.applySubscriptionEvent
                // for the webhook path — that method is intentionally
                // kept on BillingService for any future callers that
                // don't need the atomic-transition semantics.
                await client.query(
                  `UPDATE tenants
                      SET stripe_subscription_id = $1,
                          subscription_status = $2,
                          trial_ends_at = $3,
                          updated_at = NOW()
                    WHERE id = $4`,
                  [sub.id, sub.status, trialEndsAt, row.id],
                );
              }
              await client.query('COMMIT');
            } catch (err) {
              try {
                await client.query('ROLLBACK');
              } catch {
                /* best-effort */
              }
              throw err;
            } finally {
              client.release();
            }
          } else {
            // No pool wired (in-memory dev mode). Fall back to the
            // BillingService method so existing behavior is preserved.
            // Funnel events stay off in this path because we have no
            // way to read prior status.
            await deps.billingService.applySubscriptionEvent({
              customerId: sub.customer,
              subscriptionId: sub.id,
              status: sub.status,
              trialEndsAt,
            });
          }

          logger.info('Subscription status mirrored from Stripe', {
            customerId: sub.customer, subscriptionId: sub.id, status: sub.status,
          });

          // Server-side funnel events. Off when POSTHOG_API_KEY is unset.
          if (ownerClerkId) {
            const properties = {
              tenantId: funnelTenantId,
              subscriptionId: sub.id,
              priorStatus,
              newStatus: sub.status,
            };
            // KNOWN LIMITATION (deferred post-soft-launch): the
            // priorStatus → newStatus check is non-atomic. If two
            // distinct Stripe events for the same transition arrive
            // concurrently (e.g., customer.subscription.created AND a
            // customer.subscription.updated that both report
            // trialing), both handlers can read the same non-live
            // priorStatus before either applySubscriptionEvent
            // commits, and both emit trial_started. The proper fix is
            // to wrap the SELECT prior + applySubscriptionEvent in a
            // single transaction with SELECT … FOR UPDATE on the
            // tenants row so the second handler reads the first's
            // committed status. Impact is metric inflation only — no
            // user-facing harm, no duplicate Stripe charges. Tracked
            // as post-launch follow-up.
            if (sub.status === 'trialing' && priorStatus !== 'trialing') {
              recordFunnelEvent({
                distinctId: ownerClerkId,
                event: 'trial_started',
                properties,
              });
            } else if (sub.status === 'active' && priorStatus === 'trialing') {
              recordFunnelEvent({
                distinctId: ownerClerkId,
                event: 'trial_to_paid',
                properties,
              });
            } else if (sub.status === 'canceled' && priorStatus !== 'canceled') {
              recordFunnelEvent({
                distinctId: ownerClerkId,
                event: 'subscription_canceled',
                properties,
              });
            }
          }

          // Once billing reaches a live state, seed the tenant's AI model from
          // the platform default and enqueue the onboarding AI self-check.
          // Idempotent: the worker skips if already passed and the COALESCE
          // never clobbers a model already chosen for the tenant.
          if ((sub.status === 'trialing' || sub.status === 'active') && deps.pool && deps.queue) {
            const tenantRes = await deps.pool.query<{ id: string }>(
              `SELECT id FROM tenants WHERE stripe_customer_id = $1 LIMIT 1`,
              [sub.customer],
            );
            const tenantId = tenantRes.rows[0]?.id;
            if (tenantId) {
              if (config.AI_DEFAULT_MODEL) {
                await deps.pool.query(
                  `UPDATE tenant_settings
                      SET ai_model = COALESCE(ai_model, $2), updated_at = NOW()
                    WHERE tenant_id = $1`,
                  [tenantId, config.AI_DEFAULT_MODEL],
                );
              }
              const verifyPayload: VerifyAiPayload = { tenantId };
              await deps.queue.send(VERIFY_AI_JOB_TYPE, verifyPayload, `verify-ai-${tenantId}`);
              logger.info('AI verification job enqueued', { tenantId, status: sub.status });
            }
          }
        } else {
          logger.warn('customer.subscription.* missing fields', {
            eventId: event.id, type: event.type,
          });
        }

        // Auto-deprovision on cancellation. Gated behind a flag (default off)
        // because a hard purge is irreversible — we do NOT want a billing
        // glitch to nuke a paying customer the first time this fires. Only
        // acts on a true cancellation (deleted event, or status 'canceled'),
        // never on dunning states (past_due / unpaid / incomplete). Enqueues
        // a background job; never throws (must not 500 the webhook → Stripe
        // would retry forever).
        if (
          process.env.AUTO_DEPROVISION_ON_CANCEL === 'true' &&
          deps.queue &&
          deps.pool &&
          (event.type === 'customer.subscription.deleted' || sub.status === 'canceled')
        ) {
          try {
            const tenantRow = await deps.pool.query<{ id: string }>(
              `SELECT id FROM tenants WHERE stripe_customer_id = $1 LIMIT 1`,
              [sub.customer],
            );
            const tenantId = tenantRow.rows[0]?.id;
            if (tenantId) {
              const payload: DeprovisionTenantPayload = {
                tenantId,
                reason:
                  event.type === 'customer.subscription.deleted'
                    ? 'stripe_subscription_deleted'
                    : 'stripe_subscription_canceled',
                actorId: 'system:stripe_webhook',
              };
              await deps.queue.send(
                DEPROVISION_TENANT_JOB_TYPE,
                payload,
                `deprovision-${tenantId}`,
              );
              logger.warn('Auto-deprovision enqueued on subscription cancellation', {
                tenantId, customerId: sub.customer, type: event.type,
              });
            }
          } catch (err) {
            logger.error('Failed to enqueue auto-deprovision', {
              customerId: sub.customer,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // D2-4 — partial-refund tracking. Stripe fires `charge.refunded`
      // each time a refund is issued (including partials). The event
      // payload is a Charge with `refunds.data[]`; the MOST RECENT
      // refund is data[0] (Stripe orders newest-first). We persist the
      // refund magnitude onto the original payment row via the
      // recordRefund() service, which enforces the over-refund guard
      // and emits the `payment.refunded` audit event.
      //
      // Payment lookup precedence (Codex P1 #2 — PR #384):
      //   1. metadata.payment_id on the refund (set by manual API refunds)
      //   2. metadata.payment_id on the parent charge (same)
      //   3. FALLBACK: paymentRepo.findByProviderReference(tenantId,
      //      payment_intent) — our checkout creation paths attach
      //      tenant_id+invoice_id metadata but NEVER payment_id, so for
      //      every real refund only path 3 actually resolves. The
      //      payment_intent id is stamped into providerReference by the
      //      checkout.session.completed branch above.
      //
      // If none of the three resolve, we log + skip rather than guess
      // and mis-credit a refund.
      if (event.type === 'charge.refunded') {
        const charge = event.data.object as {
          id?: string;
          payment_intent?: string | { id?: string };
          metadata?: { tenant_id?: string; payment_id?: string };
          refunds?: {
            data?: Array<{
              id?: string;
              amount?: number;
              created?: number;
              status?: string;
              payment_intent?: string | { id?: string };
              metadata?: { tenant_id?: string; payment_id?: string };
            }>;
          };
        };

        if (!deps.paymentRepo) {
          logger.error('Payment repo not wired to Stripe webhook handler');
          return res.status(500).json({ error: 'Refund processing not configured' });
        }

        const refund = charge.refunds?.data?.[0];
        if (!refund || !refund.amount || refund.amount <= 0) {
          logger.warn('charge.refunded missing or zero refund amount', {
            eventId: event.id, chargeId: charge.id,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        // Codex P1 (PR #384) — only mutate payment totals for SETTLED
        // refunds. Stripe can return refunds in `pending` (e.g.
        // insufficient platform balance) or `requires_action`; these may
        // later transition to `failed` or `canceled`. We don't have a
        // `charge.refund.updated` handler yet, so recording the amount
        // on a non-succeeded refund would permanently overstate refunds
        // if Stripe later fails it. Skip-ack (200) so Stripe stops
        // retrying THIS event; the eventual `charge.refund.updated`
        // event (or a re-fired `charge.refunded` once succeeded) will
        // carry status='succeeded' and we'll record it then.
        //
        // Older API versions / older test fixtures may not carry a
        // `status` field at all — treat undefined as succeeded for
        // back-compat.
        if (refund.status !== undefined && refund.status !== 'succeeded') {
          logger.info('charge.refunded with non-succeeded refund status — deferring', {
            eventId: event.id,
            chargeId: charge.id,
            refundId: refund.id,
            refundStatus: refund.status,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, deferred: true, refundStatus: refund.status });
        }

        const tenantId =
          refund.metadata?.tenant_id ?? charge.metadata?.tenant_id;
        let paymentId =
          refund.metadata?.payment_id ?? charge.metadata?.payment_id;

        // Codex P1 #2 (PR #384) — our Stripe creation paths
        // (stripe-payment-link / stripe-payment-intent) stamp only
        // tenant_id and invoice_id into metadata, never payment_id. So
        // for every real refund the metadata.payment_id lookup misses
        // and we silently ACK'd as 'skipped' — refund tracking was
        // non-functional in production. Fall back to looking up by the
        // Stripe payment_intent which we now store as
        // provider_reference at checkout.session.completed.
        if (tenantId && !paymentId) {
          const pi = refund.payment_intent ?? charge.payment_intent;
          const piId =
            typeof pi === 'string'
              ? pi
              : (typeof pi === 'object' && pi !== null && typeof pi.id === 'string')
                ? pi.id
                : undefined;
          if (piId) {
            const found = await deps.paymentRepo.findByProviderReference(tenantId, piId);
            if (found) paymentId = found.id;
          }
        }

        if (!tenantId || !paymentId) {
          logger.warn('charge.refunded missing tenant_id/payment_id metadata and payment_intent lookup miss — cannot resolve payment', {
            eventId: event.id, chargeId: charge.id, refundId: refund.id,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        // Stripe's `created` is a unix-seconds epoch; convert to JS Date.
        const refundedAt = refund.created
          ? new Date(refund.created * 1000)
          : new Date();

        try {
          const result = await recordRefund(
            {
              tenantId,
              paymentId,
              refundCents: refund.amount,
              stripeRefundId: refund.id ?? null,
              refundedAt,
              actorId: 'system:stripe_webhook',
              actorRole: 'system',
            },
            deps.paymentRepo,
            deps.auditRepo,
          );
          logger.info('Stripe refund recorded', {
            tenantId, paymentId,
            refundCents: result.refundCents,
            totalRefundedCents: result.totalRefundedCents,
            refundId: refund.id,
          });
        } catch (refundErr) {
          if (refundErr instanceof NotFoundError) {
            // Codex P1 #3 (PR #384) — webhook delivery ordering is not
            // guaranteed; `charge.refunded` can arrive BEFORE the
            // `checkout.session.completed` that creates the payment
            // row. Surfacing this as 5xx lets Stripe retry (the outer
            // webhookRepo dedups by event id, so retries are
            // idempotent). Swallowing it the way ValidationError is
            // would leave the refund un-recorded forever.
            logger.warn('charge.refunded for unknown payment — letting Stripe retry', {
              tenantId, paymentId, refundId: refund.id,
            });
            throw refundErr; // outer catch sets webhook 'failed' + 500
          }
          if (refundErr instanceof ValidationError) {
            // Over-refund / other terminal validation — log + ack to
            // stop Stripe from hammering us. Manual reconciliation
            // required. NotFoundError above is the retryable case.
            logger.warn('charge.refunded validation failed; skipping', {
              tenantId, paymentId, refundId: refund.id,
              error: refundErr.message,
            });
          } else {
            throw refundErr;
          }
        }
      }

      // Codex P1 (PR #384) — `charge.refund.updated` handler.
      //
      // Stripe fires `charge.refund.updated` for refund status
      // transitions (e.g. ACH/bank-transfer `pending -> succeeded`).
      // It does NOT re-fire `charge.refunded`, so without this
      // handler any refund that started non-`succeeded` (deferred
      // above) would never be recorded — revenue/tax stays
      // permanently understated.
      //
      // The payload here is the Refund object directly, not a Charge
      // with a nested refunds[]. Tenant resolution prefers metadata
      // (rare — set only by manual API refunds), then falls back to a
      // cross-tenant lookup by payment_intent because the event
      // payload doesn't carry the parent charge's metadata.tenant_id.
      //
      // Per-refund idempotency is in recordRefund() itself: when
      // payment.lastRefundStripeId === refund.id, recordRefund
      // short-circuits — so receiving the same refund via both
      // charge.refunded AND charge.refund.updated does NOT double-count.
      if (event.type === 'charge.refund.updated') {
        const refund = event.data.object as {
          id?: string;
          amount?: number;
          created?: number;
          status?: string;
          payment_intent?: string | { id?: string };
          metadata?: { tenant_id?: string; payment_id?: string };
        };

        if (!deps.paymentRepo) {
          logger.error('Payment repo not wired to Stripe webhook handler');
          return res.status(500).json({ error: 'Refund processing not configured' });
        }

        // Only react to terminal-success transitions. pending/failed/canceled
        // need no state change on our end (the original charge.refunded
        // either deferred them or never recorded them).
        if (refund.status !== 'succeeded') {
          logger.info('charge.refund.updated with non-succeeded status — skipping', {
            eventId: event.id, refundId: refund.id, refundStatus: refund.status,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        if (!refund.amount || refund.amount <= 0) {
          logger.warn('charge.refund.updated missing or zero refund amount', {
            eventId: event.id, refundId: refund.id,
          });
          await webhookRepo.updateStatus(webhookEvent.id, 'processed');
          return res.status(200).json({ received: true, skipped: true });
        }

        // Tenant resolution: metadata first, then cross-tenant lookup by
        // payment_intent -> reference_number.
        let tenantId = refund.metadata?.tenant_id;
        let paymentId = refund.metadata?.payment_id;

        if (!tenantId || !paymentId) {
          const pi = refund.payment_intent;
          const piId =
            typeof pi === 'string'
              ? pi
              : (typeof pi === 'object' && pi !== null && typeof pi.id === 'string')
                ? pi.id
                : undefined;
          if (piId) {
            const found = await deps.paymentRepo.findByProviderReferenceCrossTenant(piId);
            if (found) {
              tenantId = found.tenantId;
              paymentId = found.id;
            }
          }
        }

        if (!tenantId || !paymentId) {
          logger.warn('charge.refund.updated cannot resolve payment — letting Stripe retry', {
            eventId: event.id, refundId: refund.id,
          });
          // Throw so the outer catch returns 500 -> Stripe retries.
          // findByProviderReferenceCrossTenant may miss because the
          // checkout.session.completed payment row hasn't been written
          // yet (out-of-order delivery).
          throw new NotFoundError('Payment', refund.id ?? 'unknown');
        }

        const refundedAt = refund.created ? new Date(refund.created * 1000) : new Date();

        try {
          const result = await recordRefund(
            {
              tenantId,
              paymentId,
              refundCents: refund.amount,
              stripeRefundId: refund.id ?? null,
              refundedAt,
              actorId: 'system:stripe_webhook',
              actorRole: 'system',
            },
            deps.paymentRepo,
            deps.auditRepo,
          );
          logger.info('Stripe refund recorded via charge.refund.updated', {
            tenantId, paymentId,
            refundCents: result.refundCents,
            totalRefundedCents: result.totalRefundedCents,
            refundId: refund.id,
          });
        } catch (refundErr) {
          if (refundErr instanceof NotFoundError) {
            logger.warn('charge.refund.updated for unknown payment — letting Stripe retry', {
              tenantId, paymentId, refundId: refund.id,
            });
            throw refundErr;
          }
          if (refundErr instanceof ValidationError) {
            logger.warn('charge.refund.updated validation failed; skipping', {
              tenantId, paymentId, refundId: refund.id,
              error: refundErr.message,
            });
          } else {
            throw refundErr;
          }
        }
      }

      // Invoice-to-cash — card chargeback. A dispute means the bank
      // pulled the funds back, so the payment we recorded is gone:
      // reverse it, reopening the invoice. Disputes don't carry our
      // tenant/invoice metadata, so resolve the originating payment by
      // the dispute's payment_intent (our provider_reference) via the
      // cross-tenant lookup, exactly like charge.refund.updated.
      if (event.type === 'charge.dispute.created') {
        const dispute = event.data.object as {
          id?: string;
          amount?: number;
          reason?: string;
          payment_intent?: string | { id?: string };
        };

        if (!deps.invoiceRepo || !deps.paymentRepo) {
          logger.error('Invoice/payment repos not wired to Stripe webhook handler');
          return res.status(500).json({ error: 'Dispute processing not configured' });
        }

        const pi = dispute.payment_intent;
        const piId =
          typeof pi === 'string'
            ? pi
            : (typeof pi === 'object' && pi !== null && typeof pi.id === 'string')
              ? pi.id
              : undefined;

        const payment = piId
          ? await deps.paymentRepo.findByProviderReferenceCrossTenant(piId)
          : null;

        if (!payment) {
          // Out-of-order delivery: the dispute can arrive before the
          // payment row is written. Throw so the outer catch returns 500
          // and Stripe retries (the event-id dedup makes retries idempotent).
          logger.warn('charge.dispute.created cannot resolve payment — letting Stripe retry', {
            eventId: event.id, disputeId: dispute.id,
          });
          throw new NotFoundError('Payment', dispute.id ?? 'unknown');
        }

        const result = await reversePayment(
          {
            tenantId: payment.tenantId,
            paymentId: payment.id,
            reason: 'dispute',
            correlationId: dispute.id ?? piId,
          },
          deps.invoiceRepo,
          deps.paymentRepo,
          deps.auditRepo,
          buildMoneyStateDeps(deps),
        );
        logger.warn('Payment reversed via charge.dispute.created (chargeback)', {
          tenantId: payment.tenantId,
          paymentId: payment.id,
          disputeId: dispute.id,
          disputeReason: dispute.reason,
          reversed: result.reversed,
        });
      }

      // Tier 4 (Payment methods — PR 1). account.updated events
      // mirror Connect onboarding state onto the tenant's cached
      // columns. Stripe sends these out-of-band of any user request,
      // so the webhook is the only place we learn that KYC completed.
      //
      // D2-2: we now pass `requirements.disabled_reason` through to
      // the service so it can distinguish 'restricted' (Stripe paused
      // them — must contact support) from 'pending' (KYC still in
      // progress). The boolean `deleted` flag short-circuits to
      // 'disconnected' for accounts removed upstream.
      if (deps.connectService && event.type === 'account.updated') {
        const account = event.data.object as {
          id?: string;
          deleted?: boolean;
          charges_enabled?: boolean;
          payouts_enabled?: boolean;
          details_submitted?: boolean;
          requirements?: {
            disabled_reason?: string | null;
            currently_due?: string[] | null;
          } | null;
        };
        if (account.id) {
          const disabledReason = account.requirements?.disabled_reason ?? null;
          const result = await deps.connectService.applyAccountUpdated({
            accountId: account.id,
            chargesEnabled: Boolean(account.charges_enabled),
            payoutsEnabled: Boolean(account.payouts_enabled),
            detailsSubmitted: Boolean(account.details_submitted),
            disabledReason,
            deleted: Boolean(account.deleted),
          });
          logger.info('Connect account.updated mirrored', {
            accountId: account.id,
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            disabledReason,
            deleted: account.deleted,
            updatedTenants: result.updatedTenants,
          });
        } else {
          logger.warn('account.updated missing id', { eventId: event.id });
        }
      }

      await webhookRepo.updateStatus(webhookEvent.id, 'processed');
      return res.status(200).json({ received: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Stripe webhook processing failed', { eventId: event.id, type: event.type, error: message });
      await webhookRepo.updateStatus(webhookEvent.id, 'failed', message);
      return res.status(500).json({ error: 'Processing failed' });
    }
  });

  const rejectBound = async (tenantId: string, reason: string, meta: Record<string, unknown>) => {
    if (deps.auditRepo) {
      await deps.auditRepo.create(createAuditEvent({
        tenantId,
        actorId: 'system:webhook',
        actorRole: 'system',
        eventType: 'webhook.auth_failed',
        entityType: 'webhook',
        entityId: reason,
        metadata: meta,
      }));
    }
  };
  const recordTwilio = async (kind: string, req: Request, res: Response) => {
    const tenantId = req.params.tenantId;
    // `tenantId` comes from the public URL. Reject a malformed id here, before
    // any tenant-scoped work — both the resolver AND the rejectBound audit
    // write go through setTenantContext, which throws on a non-UUID. Returning
    // 403 directly (no audit row) keeps that throw out of the void-dispatched
    // handler, where it would surface as an unhandled rejection.
    if (!isValidTenantId(tenantId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const integration = await deps.integrationResolver?.(tenantId, 'twilio');
    if (!integration || integration.provider !== 'twilio' || integration.tenantId !== tenantId) {
      await rejectBound(tenantId, 'tenant_mismatch', { kind });
      return res.status(403).json({ error: 'Forbidden' });
    }
    const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    const url = reconstructWebhookUrl(req, process.env.PUBLIC_API_URL);
    const sig = req.header('x-twilio-signature');
    const validPrimary = integration.authTokenPrimary
      ? verifyTwilioSignature(sig, url, params, integration.authTokenPrimary)
      : false;
    const validSecondary = !validPrimary && integration.authTokenSecondary
      ? verifyTwilioSignature(sig, url, params, integration.authTokenSecondary)
      : false;
    if (!validPrimary && !validSecondary) {
      await rejectBound(tenantId, 'invalid_signature', { kind });
      return res.status(403).json({ error: 'Forbidden' });
    }
    if ((req.body?.AccountSid as string | undefined) !== integration.subaccountSid) {
      await rejectBound(tenantId, 'account_sid_mismatch', { kind, accountSid: req.body?.AccountSid });
      return res.status(403).json({ error: 'Forbidden' });
    }
    const eventId = (req.body?.MessageSid as string | undefined) ?? (req.body?.CallSid as string | undefined);
    if (!eventId) return res.status(400).json({ error: 'Missing MessageSid/CallSid' });
    if (deps.webhookEventRepo) {
      const rec = await deps.webhookEventRepo.recordReceipt('twilio', eventId, kind, req.body ?? {});
      // Short-circuit ONLY on a fully-processed duplicate. A row that exists
      // but was never marked processed means an earlier delivery died between
      // receipt and dispatch (process crash) — Twilio's retry is our only
      // chance to run the handler, so it must fall through. markProcessed is
      // stamped AFTER dispatch (bottom of this handler) for the same reason:
      // stamping first turned crashes into permanently-lost messages
      // (a STOP/HELP keyword or booking reply silently dropped).
      if (!rec.inserted && rec.record?.processedAt) {
        return res.status(200).json({ received: true, duplicate: true });
      }
    }

    // P2-034 — Inbound SMS keyword dispatcher. Runs only for inbound SMS
    // (voice/status callbacks have no body to route on). The dispatcher
    // contract guarantees no throw — we still
    // wrap so an unexpected programming error here can never turn into a
    // Twilio 5xx (which would trigger a retry of an already-acknowledged
    // message and re-fire any handler side-effects).
    if (kind === 'sms') {
      const fromE164 = (req.body?.From as string | undefined) ?? '';
      const body = (req.body?.Body as string | undefined) ?? '';
      // RV-050 — MMS media (NumMedia + MediaUrlN / MediaContentTypeN).
      // Forwarded on the dispatch context; the registered media handler
      // ingests photos from verified tech phones, failure-isolated.
      const numMedia = Number.parseInt((req.body?.NumMedia as string | undefined) ?? '0', 10);
      const media: Array<{ url: string; contentType?: string }> = [];
      for (let i = 0; i < (Number.isFinite(numMedia) ? numMedia : 0); i++) {
        const url = req.body?.[`MediaUrl${i}`] as string | undefined;
        if (typeof url !== 'string' || url.length === 0) continue;
        const contentType = req.body?.[`MediaContentType${i}`] as string | undefined;
        media.push({ url, ...(typeof contentType === 'string' ? { contentType } : {}) });
      }
      let dispatchResult: { handled: boolean; handler?: string; reason?: string };
      try {
        dispatchResult = await dispatchInboundSms({
          tenantId,
          fromE164,
          body,
          messageSid: eventId,
          ...(media.length > 0 ? { media } : {}),
        });
      } catch (err) {
        logger.error('Inbound SMS dispatch failed unexpectedly', {
          tenantId,
          messageSid: eventId,
          error: err instanceof Error ? err.message : String(err),
        });
        dispatchResult = { handled: false, reason: 'handler_error' };
      }
      // UC-5b — dropped-call resume matching is handled INSIDE the
      // dispatcher by the RV-116 resume handler, which matches the caller
      // against the durable dropped_call_recoveries table (works on any
      // replica / after a restart). The old in-memory phone→session bridge
      // fallback that used to run here was deleted with the superseded B5
      // MVP (telephony/dropped-call-session-bridge.ts).
      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: 'system:twilio_inbound_sms',
            actorRole: 'system',
            eventType: dispatchResult.handled
              ? 'sms.inbound.dispatched'
              : 'sms.inbound.unhandled',
            entityType: 'webhook',
            entityId: eventId,
            metadata: {
              handler: dispatchResult.handler,
              reason: dispatchResult.reason,
              fromE164,
            },
          }),
        );
      }
    }

    // Processing complete (dispatch + audit) — only now stamp the event so a
    // crash anywhere above leaves the row 'received' and the retry reprocesses.
    if (deps.webhookEventRepo) {
      await deps.webhookEventRepo.markProcessed('twilio', eventId);
    }

    return res.status(200).json({ received: true });
  };
  // Catch-all around the async handler: recordTwilio pre-guards the known
  // throw paths, but an unexpected rejection in a void-dispatched promise
  // would otherwise leave the request hanging (Twilio waits, times out,
  // retries) and surface only as a swallowed unhandledRejection.
  const twilioRoute = (kind: string) => (req: Request, res: Response) =>
    void recordTwilio(kind, req, res).catch((err) => {
      logger.error('Twilio webhook handler failed unexpectedly', {
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  router.post('/twilio/voice/:tenantId', twilioRoute('voice'));
  router.post('/twilio/sms/:tenantId', twilioRoute('sms'));
  router.post('/twilio/status/:tenantId', twilioRoute('status'));

  // Vapi inbound-call webhook. Signature-verified (fails closed → 403),
  // idempotent on call id, records the inbound session (drives test-call
  // detection) and runs identity-based activation. Mounted with
  // express.raw() in app.ts so the HMAC sees the exact bytes.
  router.post('/vapi/:tenantId', async (req: Request, res: Response) => {
    const tenantId = req.params.tenantId;
    if (!isValidTenantId(tenantId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!deps.pool || !deps.auditRepo || !deps.webhookEventRepo) {
      return res.status(503).json({ error: 'VAPI_WEBHOOK_NOT_CONFIGURED' });
    }
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : JSON.stringify(req.body ?? {});
    // QUALITY-2026-07-12 WS4 — fail CLOSED. The per-tenant secret is the ONLY
    // credential accepted here: a body signed for tenant A verifies only at
    // tenant A. The previous global VAPI_WEBHOOK_SECRET fallback is removed —
    // it let anyone holding the shared secret forge call events for ANY tenant.
    // When the resolver returns null (tenant not yet provisioned) or throws
    // (DB error), the secret stays empty and verifyVapiSignature rejects with
    // 403. There is no tenant-less Vapi endpoint (the only route is
    // /vapi/:tenantId), so no global secret is legitimate anywhere.
    let vapiSecret = '';
    if (deps.vapiSecretResolver) {
      try {
        vapiSecret = (await deps.vapiSecretResolver(tenantId)) ?? '';
      } catch (err) {
        logger.warn('Vapi per-tenant secret resolve failed; failing closed', {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
        vapiSecret = '';
      }
    }
    try {
      const result = await handleVapiCallEvent(
        {
          pool: deps.pool,
          auditRepo: deps.auditRepo,
          webhookRepo: deps.webhookEventRepo,
          secret: vapiSecret,
          ...(deps.sendEmail ? { sendEmail: deps.sendEmail } : {}),
        },
        {
          tenantId,
          rawBody,
          signatureHeader: req.header('x-vapi-signature') ?? null,
          sharedSecretHeader: req.header('x-vapi-secret') ?? null,
        },
      );
      return res.status(result.status).json(result.body);
    } catch (err) {
      logger.error('Vapi webhook handler error', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: 'VAPI_WEBHOOK_FAILED' });
    }
  });

  router.post('/sendgrid/:tenantId', async (req: Request, res: Response) => {
    const tenantId = req.params.tenantId;
    // See recordTwilio: gate the public tenant id before any tenant-scoped
    // work so a malformed UUID can't throw inside setTenantContext.
    if (!isValidTenantId(tenantId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const integration = await deps.integrationResolver?.(tenantId, 'sendgrid');
    if (!integration || integration.provider !== 'sendgrid' || integration.tenantId !== tenantId) {
      await rejectBound(tenantId, 'tenant_mismatch', { kind: 'sendgrid' });
      return res.status(403).json({ error: 'Forbidden' });
    }
    const sig = req.header('x-twilio-email-event-webhook-signature');
    const ts = req.header('x-twilio-email-event-webhook-timestamp');
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!verifySendGridSignature({ publicKeyPem: integration.sendgridPublicKeyPem ?? '', payload: raw, signatureBase64: sig, timestamp: ts })) {
      await rejectBound(tenantId, 'invalid_signature', { kind: 'sendgrid' });
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Guarded like the Stripe/Clerk routes: a malformed (though correctly
    // signed) body must 400, not reject the async handler and hang the
    // request with no response.
    let body: unknown;
    try {
      body = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    const first = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
    const eventId = (first?.sg_event_id as string | undefined) ?? (first?.sg_message_id as string | undefined);
    if (deps.webhookEventRepo && eventId) {
      const rec = await deps.webhookEventRepo.recordReceipt('sendgrid', eventId, 'event', { events: req.body });
      if (!rec.inserted) return res.status(200).json({ received: true, duplicate: true });
      await deps.webhookEventRepo.markProcessed('sendgrid', eventId);
    }
    return res.status(200).json({ received: true });
  });

  return router;
}
