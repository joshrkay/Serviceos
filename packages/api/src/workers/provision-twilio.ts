import { randomBytes } from 'crypto';
import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { Pool } from 'pg';
import { encrypt, decrypt } from '../integrations/crypto';
import { tenantQuery } from './tenant-query';
import {
  createTwilioSubaccountWithCreds,
  createMessagingService,
  purchasePhoneNumber,
  attachNumberToMessagingService,
  listSubaccountPhoneNumbers,
  releasePhoneNumber,
} from '../integrations/twilio/provisioning';
import { getVapiClient, type VapiClient } from '../integrations/vapi/client';
import { isTwilioDeploymentEnv } from '../integrations/credentials';
import { isTwilioTestNumber } from '../telephony/phone-policy';
import { usStateFromAddress } from '../telephony/address-state';
import { buildAssistantConfig } from '../integrations/vapi/assistant-config';
import { isBillingLiveStatus } from '../billing/tenant-billing-state';
import { changeTenantNumber } from './change-twilio-number';

// Status values match migration 071_widen_tenant_integrations_status:
// 't0_requested' = provisioning in flight; 'full_readiness' = fully active.
const STATUS_PROVISIONING = 't0_requested';
const STATUS_ACTIVE = 'full_readiness';

// Deterministic stub phone assigned in non-production when no Twilio creds are
// configured, so the onboarding phone step can reach 'full_readiness' and the
// wizard is completable in dev/test/CI. This is a Twilio "magic" test number
// (https://www.twilio.com/docs/iam/test-credentials) — never a real, dialable
// line. Never used in production: the production path throws without real creds.
const STUB_DEV_PHONE_E164 = '+15005550006';

/**
 * #1061 — true when `err` is the DID-uniqueness violation from migration 274
 * (`uq_tenant_integrations_twilio_phone_e164`), i.e. another tenant already
 * holds this number.
 *
 * Matched on BOTH the SQLSTATE and the constraint name: `tenant_integrations`
 * also carries 070's `UNIQUE (tenant_id, provider)`, which raises the same
 * 23505 for an entirely different (and retryable) reason, so the code alone
 * would misclassify it.
 */
export function isDidAlreadyClaimed(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'uq_tenant_integrations_twilio_phone_e164';
}

export interface ProvisionTwilioPayload {
  tenantId: string;
  region: string | null;
  baseUrl: string;
  // Number picker: the specific E.164 the tradesperson claimed. When set, the
  // worker orders exactly this number instead of auto-picking by region.
  phoneNumber?: string;
  // #1563 — "Pick one for me": buy a number chosen by the worker (area code
  // from the business address's state, falling back to any US local).
  // Without phoneNumber or autoPick the job is the trial-checkout SETUP job:
  // it creates the subaccount + Messaging Service only and buys nothing.
  autoPick?: boolean;
  // #1563 — Settings → Phone "change number": replace the tenant's ACTIVE
  // number with this E.164 (buy new → attach → repoint → release old).
  changeTo?: string;
}

export const PROVISION_TWILIO_JOB_TYPE = 'provision_twilio_subaccount';

/**
 * #1563 — every provisioning job for a tenant runs under one per-tenant
 * Postgres advisory lock. Checkout (setup), claim, "pick one for me" and
 * change-number jobs carry DISTINCT idempotency keys (so a pick is never
 * swallowed by a pending checkout job), which means two of them can be
 * delivered concurrently; serializing them here is what stops a concurrent
 * pair from creating two subaccounts or buying two numbers. Each step after
 * the lock is resumable from persisted state, so the second job simply sees
 * the first one's work.
 *
 * Contention throws (no Twilio call, no row write): the queue retries the
 * job with backoff once the running job has released the lock. The lock is
 * session-scoped on a dedicated connection, so a crashed worker's lock dies
 * with its connection.
 */
function withTenantProvisioningLock(
  pool: Pool,
  run: (message: QueueMessage<ProvisionTwilioPayload>, logger: Logger) => Promise<void>,
): (message: QueueMessage<ProvisionTwilioPayload>, logger: Logger) => Promise<void> {
  return async (message, logger) => {
    const lockKey = `provision-twilio:${message.payload.tenantId}`;
    const client = await pool.connect();
    let locked = false;
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [lockKey],
      );
      locked = rows[0]?.locked === true;
      if (!locked) {
        throw new Error(
          `Twilio provisioning already running for tenant ${message.payload.tenantId} — will retry`,
        );
      }
      await run(message, logger);
    } finally {
      if (locked) {
        await client
          .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
          .catch(() => undefined);
      }
      client.release();
    }
  };
}

export function createProvisionTwilioWorker(deps: {
  pool: Pool;
  /** Injectable for tests; production resolves from VAPI_API_KEY via
   * getVapiClient(). When null/absent, the Vapi assistant step is skipped
   * (off-by-default), exactly like Twilio skips without its creds. */
  vapiClient?: VapiClient;
}): WorkerHandler<ProvisionTwilioPayload> {
  return {
    type: PROVISION_TWILIO_JOB_TYPE,

    handle: withTenantProvisioningLock(deps.pool, async (
      message: QueueMessage<ProvisionTwilioPayload>,
      logger: Logger,
    ): Promise<void> => {
      const { tenantId, region, baseUrl, phoneNumber: preferredNumber, autoPick, changeTo } = message.payload;
      const wantsNumber = !!preferredNumber || autoPick === true;
      const { pool } = deps;

      // WS14 — three-service topology support. This job runs on web/worker/all
      // (never on the dedicated 'voice' service, which runs zero background
      // workers), so `baseUrl` (the enqueuing process's PUBLIC_API_URL) is the
      // WEB domain. But the number's VOICE surfaces must point at the dedicated
      // voice service when one exists, or every newly-provisioned number would
      // silently ride the web service's deploy/drain window — defeating the
      // split for post-cutover tenants. VOICE_PUBLIC_URL (set on the web and
      // worker services, where this job executes; read raw from process.env at
      // job-execution time, same pattern as PUBLIC_API_URL) is the voice
      // service's public base. Unset ⇒ single/two-service topology ⇒ fall back
      // to baseUrl (today's behavior, unchanged).
      //
      // URL → base mapping (see docs/deployment.md "Optional third service"):
      // - VoiceUrl (/api/telephony/voice — TwiML; the live call rides this
      //   service and its <Stream> targets this service's WS) → voiceBaseUrl
      // - IncomingPhoneNumber StatusCallback (/webhooks/twilio/status/:tenantId
      //   — voice-CALL lifecycle events for this number) → voiceBaseUrl, so
      //   all Twilio call traffic for the number stays on one domain
      // - Messaging service InboundRequestUrl (/webhooks/twilio/sms/:tenantId)
      //   → baseUrl: SMS is not a live-call surface; its dispatch pipeline is
      //   web/worker work and gains nothing from the voice domain
      // - Vapi serverUrl (/webhooks/vapi/:tenantId) → baseUrl: Vapi calls live
      //   on Vapi's infrastructure (not our media-streams WS), the webhook is
      //   a 200-ack event feed verified by per-tenant HMAC (no PUBLIC_API_URL
      //   URL reconstruction), so our voice service's drain is irrelevant
      const voiceBaseUrl = process.env.VOICE_PUBLIC_URL?.replace(/\/+$/, '') || baseUrl;

      const masterSid = process.env.TWILIO_ACCOUNT_SID;
      const masterToken = process.env.TWILIO_AUTH_TOKEN;
      const encKey = process.env.TENANT_ENCRYPTION_KEY;

      if (!masterSid || !masterToken) {
        // Dev/test/CI have no Twilio creds. Previously this branch returned
        // silently, but deriveOnboardingStatus only marks the `phone` step done
        // when twilioStatus === 'full_readiness' — so skipping left the phone
        // step 'current' forever and the onboarding wizard un-completable in
        // every Twilio-less environment. Instead, write a DETERMINISTIC STUB
        // integration (a Twilio magic test number, never a real line) so
        // onboarding can complete. Strictly non-deployment — every real
        // deployment (production / prod / staging) still throws and requires
        // real provisioning. Gating on the canonical isTwilioDeploymentEnv
        // (not a bare `!== 'production'`) closes the hole where a misconfigured
        // 'prod'/'staging' deploy with missing creds silently onboarded on a
        // fake test number.
        if (!isTwilioDeploymentEnv(process.env.NODE_ENV)) {
          logger.warn(
            'Twilio creds absent — assigning STUB twilio integration (non-production only); ' +
              'onboarding phone step will complete with a FAKE test number, nothing real provisioned',
            { tenantId, stubPhoneE164: STUB_DEV_PHONE_E164 },
          );
          await tenantQuery(
            pool,
            tenantId,
            `INSERT INTO tenant_integrations (tenant_id, provider, status, provider_data)
             VALUES ($1, 'twilio', $2, $3::jsonb)
             ON CONFLICT (tenant_id, provider) DO UPDATE
               SET status = $2,
                   provider_data = tenant_integrations.provider_data || $3::jsonb,
                   last_error = NULL,
                   updated_at = NOW()`,
            [tenantId, STATUS_ACTIVE, JSON.stringify({ phoneE164: STUB_DEV_PHONE_E164, stub: true })],
          );
          return;
        }
        throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
      }
      if (!encKey) {
        if (!isTwilioDeploymentEnv(process.env.NODE_ENV)) {
          logger.info('Twilio provisioning skipped — TENANT_ENCRYPTION_KEY not set', { tenantId });
          return;
        }
        throw new Error('TENANT_ENCRYPTION_KEY must be set');
      }

      // Trial-checkout gating: a Twilio number is real, recurring money, so
      // it is only ever bought for a tenant that has completed billing (card
      // on file). This gate is the invariant — no caller (claim/retry routes,
      // replays, ops scripts) can spend Twilio money on a tire-kicker. Skips
      // are quiet and safe: the checkout webhook re-enqueues with the same
      // stable key once billing goes live. (The dev-stub branch above returns
      // before this, so Twilio-less environments are unaffected.)
      const { rows: billingRows } = await tenantQuery<{
        subscription_status: string | null;
      }>(
        pool,
        tenantId,
        `SELECT subscription_status FROM tenants WHERE id = $1`,
        [tenantId],
      );
      const billingStatus = billingRows[0]?.subscription_status ?? null;
      if (!isBillingLiveStatus(billingStatus)) {
        logger.info('Twilio provisioning skipped — tenant has not completed billing', {
          tenantId,
          billingStatus,
        });
        return;
      }

      // #1563 — Settings → Phone "change number" (needs an ACTIVE line).
      if (changeTo) {
        await changeTenantNumber({
          pool,
          tenantId,
          changeTo,
          voiceBaseUrl,
          encKey,
          vapi: deps.vapiClient ?? getVapiClient(),
          message,
          logger,
        });
        return;
      }

      // Check current state — idempotent: skip if already active
      const { rows } = await tenantQuery<{
        status: string;
        subaccount_sid: string | null;
        auth_token_primary_enc: string | null;
        provider_data: { messagingServiceSid?: string; phoneNumberSid?: string; phoneE164?: string };
      }>(
        pool,
        tenantId,
        `SELECT status, subaccount_sid, auth_token_primary_enc, provider_data
         FROM tenant_integrations
         WHERE tenant_id = $1 AND provider = 'twilio'`,
        [tenantId]
      );

      if (rows[0]?.status === STATUS_ACTIVE) {
        logger.info('Twilio subaccount already active, skipping', { tenantId });
        return;
      }

      // Upsert row into provisioning state. RETURNING gives us the post-upsert
      // row so we don't act on stale data from the initial SELECT.
      const upserted = await tenantQuery<{
        subaccount_sid: string | null;
        auth_token_primary_enc: string | null;
        provider_data: { messagingServiceSid?: string; phoneNumberSid?: string; phoneE164?: string };
      }>(
        pool,
        tenantId,
        `INSERT INTO tenant_integrations (tenant_id, provider, status)
         VALUES ($1, 'twilio', $2)
         ON CONFLICT (tenant_id, provider) DO UPDATE
           SET status = $2, last_error = NULL, updated_at = NOW()
         RETURNING subaccount_sid, auth_token_primary_enc, provider_data`,
        [tenantId, STATUS_PROVISIONING]
      );
      const current = upserted.rows[0];

      try {
        // Step 1 — create subaccount (skip if already created on a previous attempt)
        let subaccountSid = current.subaccount_sid ?? null;
        let authToken: string;

        if (!subaccountSid) {
          logger.info('Creating Twilio subaccount', { tenantId });
          const sub = await createTwilioSubaccountWithCreds(
            masterSid,
            masterToken,
            `serviceos-tenant-${tenantId}`
          );
          subaccountSid = sub.sid;
          authToken = sub.authToken;
          await tenantQuery(
            pool,
            tenantId,
            `UPDATE tenant_integrations
             SET subaccount_sid = $1, auth_token_primary_enc = $2, updated_at = NOW()
             WHERE tenant_id = $3 AND provider = 'twilio'`,
            [subaccountSid, encrypt(authToken, encKey), tenantId]
          );
          logger.info('Twilio subaccount created', { tenantId, subaccountSid });
        } else {
          authToken = decrypt(current.auth_token_primary_enc!, encKey);
          logger.info('Resuming provisioning with existing subaccount', { tenantId, subaccountSid });
        }

        const providerData = current.provider_data ?? {};

        // Step 2 — create messaging service
        let messagingServiceSid = providerData.messagingServiceSid ?? null;
        if (!messagingServiceSid) {
          logger.info('Creating Twilio messaging service', { tenantId });
          messagingServiceSid = await createMessagingService(
            subaccountSid,
            authToken,
            `serviceos-${tenantId}`,
            `${baseUrl}/webhooks/twilio/sms/${tenantId}`
          );
          await tenantQuery(
            pool,
            tenantId,
            `UPDATE tenant_integrations
             SET provider_data = provider_data || $1::jsonb, updated_at = NOW()
             WHERE tenant_id = $2 AND provider = 'twilio'`,
            [JSON.stringify({ messagingServiceSid }), tenantId]
          );
        }

        // #1563 — the trial-checkout job stops here: the subaccount and
        // Messaging Service are free, the number is not. A number is bought
        // only on the owner's explicit pick (/phone/claim) or "Pick one for
        // me" (/phone/retry → autoPick). Status stays 't0_requested' (the
        // phone step stays 'current'); `awaitingPick` tells the UI to show
        // the picker instead of a "claiming…" spinner.
        if (!wantsNumber && !providerData.phoneNumberSid) {
          await tenantQuery(
            pool,
            tenantId,
            `UPDATE tenant_integrations
             SET provider_data = provider_data || $1::jsonb, updated_at = NOW()
             WHERE tenant_id = $2 AND provider = 'twilio'`,
            [JSON.stringify({ awaitingPick: true }), tenantId]
          );
          logger.info('Twilio subaccount + Messaging Service ready — awaiting the owner\'s number pick', {
            tenantId,
            subaccountSid,
          });
          return;
        }

        // Step 3 — purchase phone number.
        // Idempotency: if we have a SID persisted, reuse it. Otherwise list
        // any numbers already owned by this subaccount before buying — this
        // recovers from crash-after-purchase-before-persist (see PR review).
        // Subaccounts are tenant-scoped, so the only numbers there are ones
        // we previously purchased for this tenant.
        let phoneNumberSid = providerData.phoneNumberSid ?? null;
        let phoneE164 = providerData.phoneE164 ?? null;
        if (!phoneNumberSid) {
          const existing = await listSubaccountPhoneNumbers(subaccountSid, authToken);
          if (existing.length > 0) {
            phoneNumberSid = existing[0].sid;
            phoneE164 = existing[0].phoneNumber;
            logger.info('Recovered orphaned phone number from previous attempt', {
              tenantId, phoneE164,
            });
          } else {
            logger.info('Purchasing phone number', {
              tenantId,
              region,
              preferred: preferredNumber ?? null,
            });
            // #1563 — "Pick one for me": default to the business address's
            // state area code; purchasePhoneNumber falls back to any US local.
            let searchRegion = region;
            if (!preferredNumber && !searchRegion) {
              const addr = await tenantQuery<{ business_address: string | null }>(
                pool,
                tenantId,
                `SELECT business_address FROM tenant_settings WHERE tenant_id = $1`,
                [tenantId],
              );
              searchRegion = usStateFromAddress(addr.rows[0]?.business_address);
            }
            let number;
            try {
              number = await purchasePhoneNumber(
                subaccountSid,
                authToken,
                searchRegion,
                // VoiceUrl must return TwiML — point it at the existing
                // /api/telephony/voice handler which resolves tenant from
                // the inbound `to` number. The /webhooks/twilio/* routes only
                // 200-ack and don't emit TwiML, so they'd break call handling.
                // Both voice-call surfaces use voiceBaseUrl (WS14 — the
                // dedicated voice service's domain when VOICE_PUBLIC_URL is
                // set; baseUrl otherwise). See the mapping comment above.
                `${voiceBaseUrl}/api/telephony/voice`,
                `${voiceBaseUrl}/webhooks/twilio/status/${tenantId}`,
                preferredNumber
              );
            } catch (purchaseErr) {
              const errMsg =
                purchaseErr instanceof Error ? purchaseErr.message : String(purchaseErr);
              // twilioPost embeds the HTTP status as "→ <status>:". For a
              // CLAIMED number, a 4xx (other than 429) means the number itself
              // is the problem — taken since the picker listed it, or otherwise
              // unpurchasable — which retrying can't fix: record a re-pickable
              // failure and stop (don't retry-loop). 429 / 5xx / network errors
              // are transient and MUST rethrow so the queue retries, exactly
              // like the auto-pick path; otherwise a momentary Twilio blip would
              // wrongly tell the user their valid number is gone.
              const statusMatch = errMsg.match(/→\s*(\d{3}):/);
              const status = statusMatch ? Number(statusMatch[1]) : 0;
              const permanentlyUnavailable =
                !!preferredNumber && status >= 400 && status < 500 && status !== 429;
              if (permanentlyUnavailable) {
                const msg = `Selected number ${preferredNumber} is no longer available — please choose another`;
                logger.warn('Preferred number unavailable at purchase', { tenantId, error: errMsg });
                try {
                  await tenantQuery(
                    pool,
                    tenantId,
                    `UPDATE tenant_integrations
                     SET status = 'failed', last_error = $1,
                 provider_data = provider_data - 'pendingPick', updated_at = NOW()
                     WHERE tenant_id = $2 AND provider = 'twilio'`,
                    [msg, tenantId]
                  );
                } catch (dbErr) {
                  // If we can't even record the failure, don't silently complete
                  // the job and strand the tenant at 't0_requested' — rethrow so
                  // the queue retries and the status eventually lands.
                  logger.error('Failed to record preferred-number failure', {
                    tenantId,
                    error: dbErr instanceof Error ? dbErr.message : String(dbErr),
                  });
                  throw purchaseErr;
                }
                return;
              }
              throw purchaseErr;
            }
            phoneNumberSid = number.sid;
            phoneE164 = number.phoneNumber;
            logger.info('Phone number purchased', { tenantId, phoneE164 });
          }
          // #880 — hard stop: never persist a Twilio magic test number
          // (+1500555xxxx) as a tenant's real line. Reaching here with one —
          // whether "purchased" or recovered from the subaccount — means the
          // configured Twilio credentials are TEST credentials (test creds can
          // only ever transact magic numbers). Retrying can't fix credentials,
          // so record an operator-actionable failure and stop, exactly like
          // the unavailable-preferred-number path above. The dev-stub branch
          // near the top of this handler is intentionally NOT affected: it
          // writes its stub (with `stub: true`) before this code runs.
          if (phoneE164 && isTwilioTestNumber(phoneE164)) {
            const msg =
              `Refusing to persist Twilio test number ${phoneE164} as the tenant line — ` +
              'the configured Twilio credentials appear to be TEST credentials; ' +
              'fix TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN and re-run provisioning';
            logger.error('Twilio returned a magic test number during real provisioning', {
              tenantId,
              phoneE164,
            });
            await tenantQuery(
              pool,
              tenantId,
              `UPDATE tenant_integrations
               SET status = 'failed', last_error = $1,
                 provider_data = provider_data - 'pendingPick', updated_at = NOW()
               WHERE tenant_id = $2 AND provider = 'twilio'`,
              [msg, tenantId]
            );
            return;
          }
          // #1061 — this is the write the DID-uniqueness index guards
          // (uq_tenant_integrations_twilio_phone_e164, migration 274). A
          // 23505 here means another tenant already holds this DID, which
          // would otherwise have made inbound routing and credential
          // selection a LIMIT 1 coin-flip between the two.
          //
          // Handled exactly like the unavailable-preferred-number and magic
          // test-number cases above: record an operator-actionable failure
          // and STOP. Retrying cannot help — the number belongs to someone
          // else until a human reassigns it — and the raw Postgres text
          // ("duplicate key value violates unique constraint ...") is not
          // something an operator can act on.
          try {
            await tenantQuery(
              pool,
              tenantId,
              `UPDATE tenant_integrations
               SET provider_data = provider_data || $1::jsonb, updated_at = NOW()
               WHERE tenant_id = $2 AND provider = 'twilio'`,
              [JSON.stringify({ phoneNumberSid, phoneE164 }), tenantId]
            );
          } catch (err) {
            if (!isDidAlreadyClaimed(err)) throw err;
            logger.error('Twilio DID already claimed by another tenant', {
              tenantId,
              phoneE164,
              phoneNumberSid,
            });

            // The number was purchased (or recovered) into THIS tenant's
            // subaccount moments ago, and the write that would have recorded
            // its SID is the one that just failed — so nothing in the DB knows
            // it exists. Hand it back, or two things go wrong: the tenant pays
            // for a line it can never use, and the next run takes the
            // `!phoneNumberSid` branch above, where listSubaccountPhoneNumbers
            // returns this very number and walks into the same conflict. That
            // would make the "provision this tenant on a different number"
            // advice below impossible to act on. (PR #1120 review.)
            let released = false;
            let releaseError: string | null = null;
            try {
              await releasePhoneNumber(subaccountSid, authToken, phoneNumberSid!);
              released = true;
            } catch (releaseErr) {
              releaseError =
                releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
              logger.error('Failed to release the conflicting Twilio number', {
                tenantId,
                phoneNumberSid,
                error: releaseError,
              });
            }

            const conflict =
              `Phone number ${phoneE164} is already assigned to another tenant — ` +
              'a DID can serve only one tenant (inbound routing resolves the tenant ' +
              'from the number).';
            const msg = released
              ? `${conflict} The number just purchased for this tenant has been released, ` +
                'so nothing is being billed for it. Release the number from the other ' +
                'tenant, or provision this tenant on a different number, then re-run ' +
                'provisioning.'
              : `${conflict} Releasing the number just purchased for this tenant FAILED ` +
                `(${releaseError}) — release ${phoneNumberSid} from subaccount ` +
                `${subaccountSid} by hand, or the next provisioning run will recover it ` +
                'and hit this same conflict.';

            await tenantQuery(
              pool,
              tenantId,
              `UPDATE tenant_integrations
               SET status = 'failed', last_error = $1,
                 provider_data = provider_data - 'pendingPick', updated_at = NOW()
               WHERE tenant_id = $2 AND provider = 'twilio'`,
              [msg, tenantId]
            );

            // A successful release is terminal — retrying cannot un-claim the
            // DID. A failed one is not: throw so the queue comes back and
            // re-attempts the cleanup rather than stranding a paid orphan.
            if (!released) throw new Error(msg);
            return;
          }
        }

        // Step 4 — attach number to messaging service. Skip when a previous
        // attempt already attached: Twilio rejects duplicate associations,
        // which would otherwise stick the job in a retry loop.
        const numberAttached = (providerData as { numberAttached?: boolean }).numberAttached === true;
        if (!numberAttached) {
          logger.info('Attaching number to messaging service', { tenantId });
          await attachNumberToMessagingService(
            subaccountSid,
            authToken,
            messagingServiceSid,
            phoneNumberSid
          );
          await tenantQuery(
            pool,
            tenantId,
            `UPDATE tenant_integrations
             SET provider_data = provider_data || $1::jsonb, updated_at = NOW()
             WHERE tenant_id = $2 AND provider = 'twilio'`,
            [JSON.stringify({ numberAttached: true }), tenantId]
          );
        }

        // Step 4.5 — create the Vapi assistant linked to this number.
        // Off-by-default: skipped when VAPI_API_KEY isn't configured (no
        // client). Best-effort — a Vapi hiccup must NOT fail Twilio
        // readiness (SMS/voice still come up); the next provisioning run
        // retries assistant creation while vapi_assistant_id is still null.
        const vapi = deps.vapiClient ?? getVapiClient();
        if (vapi && phoneE164) {
          try {
            const cfgRes = await tenantQuery<{
              business_name: string | null;
              voice_greeting: string | null;
              voice_id: string | null;
              services_offered: string[] | null;
              vapi_assistant_id: string | null;
            }>(
              pool,
              tenantId,
              `SELECT business_name, voice_greeting, voice_id, services_offered, vapi_assistant_id
                 FROM tenant_settings WHERE tenant_id = $1`,
              [tenantId],
            );
            const cfg = cfgRes.rows[0];
            if (cfg && !cfg.vapi_assistant_id) {
              // Per-tenant webhook secret: Vapi echoes serverUrlSecret back on
              // every call event, and /webhooks/vapi/:tenantId verifies against
              // THIS tenant's stored value — so a body signed for one tenant
              // can't be replayed at another. Random per tenant, never the
              // shared global secret.
              const vapiWebhookSecret = randomBytes(32).toString('hex');
              const assistantConfig = buildAssistantConfig({
                businessName: cfg.business_name ?? 'ServiceOS',
                greeting: cfg.voice_greeting,
                voicePresetId: cfg.voice_id,
                services: cfg.services_offered ?? [],
                serverUrl: `${baseUrl}/webhooks/vapi/${tenantId}`,
                serverUrlSecret: vapiWebhookSecret,
              });
              const { assistantId } = await vapi.createAssistant(assistantConfig);
              await vapi.linkPhoneNumber({
                assistantId,
                phoneE164,
                ...(phoneNumberSid ? { twilioPhoneNumberSid: phoneNumberSid } : {}),
              });
              await tenantQuery(
                pool,
                tenantId,
                `UPDATE tenant_settings
                   SET vapi_assistant_id = $1, vapi_webhook_secret = $2, updated_at = NOW()
                 WHERE tenant_id = $3`,
                [assistantId, vapiWebhookSecret, tenantId],
              );
              await tenantQuery(
                pool,
                tenantId,
                `UPDATE tenant_integrations
                   SET provider_data = provider_data || $1::jsonb, updated_at = NOW()
                 WHERE tenant_id = $2 AND provider = 'twilio'`,
                [JSON.stringify({ vapiAssistantId: assistantId }), tenantId],
              );
              logger.info('Vapi assistant created and linked', { tenantId, assistantId });
            }
          } catch (vapiErr) {
            logger.error('Vapi assistant creation failed (Twilio readiness unaffected)', {
              tenantId,
              error: vapiErr instanceof Error ? vapiErr.message : String(vapiErr),
            });
          }
        }

        // Step 5 — mark active (the pick, if any, is done)
        await tenantQuery(
          pool,
          tenantId,
          `UPDATE tenant_integrations
           SET status = $2, provisioned_at = NOW(),
               provider_data = provider_data - 'pendingPick' - 'awaitingPick',
               updated_at = NOW()
           WHERE tenant_id = $1 AND provider = 'twilio'`,
          [tenantId, STATUS_ACTIVE]
        );

        if (phoneE164) {
          await tenantQuery(
            pool,
            tenantId,
            `UPDATE tenant_settings
             SET business_phone = COALESCE(NULLIF(TRIM(business_phone), ''), $1),
                 updated_at = NOW()
             WHERE tenant_id = $2`,
            [phoneE164, tenantId],
          );
        }

        logger.info('Twilio provisioning complete', { tenantId, subaccountSid, phoneE164 });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Twilio provisioning failed', { tenantId, error });
        await tenantQuery(
          pool,
          tenantId,
          `UPDATE tenant_integrations
           SET status = 'failed', last_error = $1,
                 provider_data = provider_data - 'pendingPick', updated_at = NOW()
           WHERE tenant_id = $2 AND provider = 'twilio'`,
          [error, tenantId]
        ).catch(() => {});
        throw err;
      }
    }),
  };
}
