import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { Pool } from 'pg';
import { encrypt } from '../integrations/crypto';
import {
  createTwilioSubaccount,
  createMessagingService,
  purchasePhoneNumber,
  attachNumberToMessagingService,
} from '../integrations/twilio/provisioning';

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
      const { rows } = await pool.query<{
        status: string;
        subaccount_sid: string | null;
        auth_token_primary_enc: string | null;
        provider_data: { messagingServiceSid?: string; phoneNumberSid?: string; phoneE164?: string };
      }>(
        `SELECT status, subaccount_sid, auth_token_primary_enc, provider_data
         FROM tenant_integrations
         WHERE tenant_id = $1 AND provider = 'twilio'`,
        [tenantId]
      );

      if (rows[0]?.status === 'active') {
        logger.info('Twilio subaccount already active, skipping', { tenantId });
        return;
      }

      // Upsert row into provisioning state
      await pool.query(
        `INSERT INTO tenant_integrations (tenant_id, provider, status)
         VALUES ($1, 'twilio', 'provisioning')
         ON CONFLICT (tenant_id, provider) DO UPDATE
           SET status = 'provisioning', last_error = NULL, updated_at = NOW()`,
        [tenantId]
      );

      try {
        // Step 1 — create subaccount (skip if already created on a previous attempt)
        let subaccountSid = rows[0]?.subaccount_sid ?? null;
        let authToken: string;

        if (!subaccountSid) {
          logger.info('Creating Twilio subaccount', { tenantId });
          const sub = await createTwilioSubaccount(
            masterSid,
            masterToken,
            `serviceos-tenant-${tenantId}`
          );
          subaccountSid = sub.sid;
          authToken = sub.authToken;
          await pool.query(
            `UPDATE tenant_integrations
             SET subaccount_sid = $1, auth_token_primary_enc = $2, updated_at = NOW()
             WHERE tenant_id = $3 AND provider = 'twilio'`,
            [subaccountSid, encrypt(authToken, encKey), tenantId]
          );
          logger.info('Twilio subaccount created', { tenantId, subaccountSid });
        } else {
          const { decrypt } = await import('../integrations/crypto');
          authToken = decrypt(rows[0].auth_token_primary_enc!, encKey);
          logger.info('Resuming provisioning with existing subaccount', { tenantId, subaccountSid });
        }

        const providerData = rows[0]?.provider_data ?? {};

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
          await pool.query(
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
          await pool.query(
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
        await pool.query(
          `UPDATE tenant_integrations
           SET status = 'active', provisioned_at = NOW(), updated_at = NOW()
           WHERE tenant_id = $1 AND provider = 'twilio'`,
          [tenantId]
        );

        logger.info('Twilio provisioning complete', { tenantId, subaccountSid, phoneE164 });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Twilio provisioning failed', { tenantId, error });
        await pool.query(
          `UPDATE tenant_integrations
           SET status = 'failed', last_error = $1, updated_at = NOW()
           WHERE tenant_id = $2 AND provider = 'twilio'`,
          [error, tenantId]
        );
        throw err;
      }
    },
  };
}
