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
} from '../integrations/twilio/provisioning';

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
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
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

        // Step 3 — purchase phone number
        let phoneNumberSid = providerData.phoneNumberSid ?? null;
        let phoneE164 = providerData.phoneE164 ?? null;
        if (!phoneNumberSid) {
          logger.info('Purchasing phone number', { tenantId, region });
          const number = await purchasePhoneNumber(
            subaccountSid,
            authToken,
            region,
            `${baseUrl}/webhooks/twilio/voice/${tenantId}`,
            `${baseUrl}/webhooks/twilio/status/${tenantId}`
          );
          phoneNumberSid = number.sid;
          phoneE164 = number.phoneNumber;
          await tenantQuery(
            pool,
            tenantId,
            `UPDATE tenant_integrations
             SET provider_data = provider_data || $1::jsonb, updated_at = NOW()
             WHERE tenant_id = $2 AND provider = 'twilio'`,
            [JSON.stringify({ phoneNumberSid, phoneE164 }), tenantId]
          );
          logger.info('Phone number purchased', { tenantId, phoneE164 });
        }

        // Step 4 — attach number to messaging service
        logger.info('Attaching number to messaging service', { tenantId });
        await attachNumberToMessagingService(
          subaccountSid,
          authToken,
          messagingServiceSid,
          phoneNumberSid
        );

        // Step 5 — mark active
        await tenantQuery(
          pool,
          tenantId,
          `UPDATE tenant_integrations
           SET status = $2, provisioned_at = NOW(), updated_at = NOW()
           WHERE tenant_id = $1 AND provider = 'twilio'`,
          [tenantId, STATUS_ACTIVE]
        );

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
