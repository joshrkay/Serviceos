import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { encrypt, decrypt } from '../integrations/crypto';
import { setTenantContext } from '../db/schema';
import {
  createTwilioSubaccountWithCreds,
  createMessagingService,
  purchasePhoneNumber,
  attachNumberToMessagingService,
  listSubaccountPhoneNumbers,
} from '../integrations/twilio/provisioning';
import { getVapiClient, type VapiClient } from '../integrations/vapi/client';
import { buildAssistantConfig } from '../integrations/vapi/assistant-config';

// Status values match migration 071_widen_tenant_integrations_status:
// 't0_requested' = provisioning in flight; 'full_readiness' = fully active.
const STATUS_PROVISIONING = 't0_requested';
const STATUS_ACTIVE = 'full_readiness';

// tenant_integrations is FORCE ROW LEVEL SECURITY with a policy on
// app.current_tenant_id. Background workers run outside withTenantTransaction,
// so every DB op against this table must run in a transaction that sets the
// GUC first. Twilio HTTP calls happen between these blocks — we don't hold
// a DB transaction open across network I/O.
async function tenantQuery<R extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  tenantId: string,
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<R>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(setTenantContext(tenantId));
    const result = await client.query<R>(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
    throw err;
  } finally {
    // GUC leak fix: plain `SET app.current_tenant_id` persists past
    // COMMIT/ROLLBACK on the underlying connection. Clear it before
    // release so the next pool checkout doesn't inherit this tenant's
    // context.
    try { await client.query('RESET app.current_tenant_id'); } catch { /* ignore */ }
    client.release();
  }
}

export interface ProvisionTwilioPayload {
  tenantId: string;
  region: string | null;
  baseUrl: string;
}

export const PROVISION_TWILIO_JOB_TYPE = 'provision_twilio_subaccount';

export function createProvisionTwilioWorker(deps: {
  pool: Pool;
  /** Injectable for tests; production resolves from VAPI_API_KEY via
   * getVapiClient(). When null/absent, the Vapi assistant step is skipped
   * (off-by-default), exactly like Twilio skips without its creds. */
  vapiClient?: VapiClient;
}): WorkerHandler<ProvisionTwilioPayload> {
  return {
    type: PROVISION_TWILIO_JOB_TYPE,

    async handle(message: QueueMessage<ProvisionTwilioPayload>, logger: Logger): Promise<void> {
      const { tenantId, region, baseUrl } = message.payload;
      const { pool } = deps;

      const masterSid = process.env.TWILIO_ACCOUNT_SID;
      const masterToken = process.env.TWILIO_AUTH_TOKEN;
      const encKey = process.env.TENANT_ENCRYPTION_KEY;

      if (!masterSid || !masterToken) {
        // Skip silently in dev when Twilio isn't configured
        if (process.env.NODE_ENV !== 'production') {
          logger.info('Twilio provisioning skipped — TWILIO_ACCOUNT_SID/AUTH_TOKEN not set', { tenantId });
          return;
        }
        throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
      }
      if (!encKey) {
        if (process.env.NODE_ENV !== 'production') {
          logger.info('Twilio provisioning skipped — TENANT_ENCRYPTION_KEY not set', { tenantId });
          return;
        }
        throw new Error('TENANT_ENCRYPTION_KEY must be set');
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
            logger.info('Purchasing phone number', { tenantId, region });
            const number = await purchasePhoneNumber(
              subaccountSid,
              authToken,
              region,
              // VoiceUrl must return TwiML — point it at the existing
              // /api/telephony/voice handler which resolves tenant from
              // the inbound `to` number. The /webhooks/twilio/* routes only
              // 200-ack and don't emit TwiML, so they'd break call handling.
              `${baseUrl}/api/telephony/voice`,
              `${baseUrl}/webhooks/twilio/status/${tenantId}`
            );
            phoneNumberSid = number.sid;
            phoneE164 = number.phoneNumber;
            logger.info('Phone number purchased', { tenantId, phoneE164 });
          }
          await tenantQuery(
            pool,
            tenantId,
            `UPDATE tenant_integrations
             SET provider_data = provider_data || $1::jsonb, updated_at = NOW()
             WHERE tenant_id = $2 AND provider = 'twilio'`,
            [JSON.stringify({ phoneNumberSid, phoneE164 }), tenantId]
          );
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
              const assistantConfig = buildAssistantConfig({
                businessName: cfg.business_name ?? 'ServiceOS',
                greeting: cfg.voice_greeting,
                voicePresetId: cfg.voice_id,
                services: cfg.services_offered ?? [],
                serverUrl: `${baseUrl}/webhooks/vapi/${tenantId}`,
                ...(process.env.VAPI_WEBHOOK_SECRET
                  ? { serverUrlSecret: process.env.VAPI_WEBHOOK_SECRET }
                  : {}),
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
                `UPDATE tenant_settings SET vapi_assistant_id = $1, updated_at = NOW() WHERE tenant_id = $2`,
                [assistantId, tenantId],
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

        // Step 5 — mark active
        await tenantQuery(
          pool,
          tenantId,
          `UPDATE tenant_integrations
           SET status = $2, provisioned_at = NOW(), updated_at = NOW()
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
           SET status = 'failed', last_error = $1, updated_at = NOW()
           WHERE tenant_id = $2 AND provider = 'twilio'`,
          [error, tenantId]
        ).catch(() => {});
        throw err;
      }
    },
  };
}
