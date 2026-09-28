import { WorkerHandler, QueueMessage } from '../queues/queue';
import { Logger } from '../logging/logger';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { decrypt } from '../integrations/crypto';
import { applyTenantContext } from '../db/rls-runtime-role';
import { releasePhoneNumber } from '../integrations/twilio/provisioning';
import { getSentryClient } from '../monitoring/sentry';

export const RELEASE_TWILIO_NUMBER_JOB_TYPE = 'release_twilio_number';

export interface ReleaseTwilioNumberPayload {
  tenantId: string;
  reason: 'stripe_subscription_deleted' | 'stripe_subscription_canceled';
}

// tenant_integrations is FORCE ROW LEVEL SECURITY with a policy on
// app.current_tenant_id. Background workers run outside withTenantTransaction,
// so every DB op against this table must run in a transaction that sets the
// GUC first. (Same pattern as workers/provision-twilio.ts.)
async function tenantQuery<R extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  tenantId: string,
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<R>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyTenantContext(client, tenantId, { transactional: true });
    const result = await client.query<R>(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* best-effort */ }
    throw err;
  } finally {
    try { await client.query('RESET app.current_tenant_id'); } catch { /* ignore */ }
    client.release();
  }
}

function reportReleaseFailure(logger: Logger, tenantId: string, reason: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Twilio number release failed (best-effort; job will not retry)', {
    tenantId,
    reason,
    error: message,
  });
  // Monitoring must never break the cleanup path.
  try {
    getSentryClient().withScope((scope) => {
      scope.setTag('tenant_id', tenantId);
      scope.setTag('job', RELEASE_TWILIO_NUMBER_JOB_TYPE);
      scope.captureException(err instanceof Error ? err : new Error(message));
    });
  } catch { /* ignore */ }
}

export function createReleaseTwilioNumberWorker(deps: {
  pool: Pool;
}): WorkerHandler<ReleaseTwilioNumberPayload> {
  return {
    type: RELEASE_TWILIO_NUMBER_JOB_TYPE,

    async handle(message: QueueMessage<ReleaseTwilioNumberPayload>, logger: Logger): Promise<void> {
      const { tenantId, reason } = message.payload;
      const { pool } = deps;

      const { rows } = await tenantQuery<{
        subaccount_sid: string | null;
        auth_token_primary_enc: string | null;
        provider_data: {
          phoneNumberSid?: string;
          phoneE164?: string;
          numberAttached?: boolean;
          stub?: boolean;
        } | null;
      }>(
        pool,
        tenantId,
        `SELECT subaccount_sid, auth_token_primary_enc, provider_data
           FROM tenant_integrations
          WHERE tenant_id = $1 AND provider = 'twilio'
          LIMIT 1`,
        [tenantId]
      );
      const row = rows[0];

      // Idempotent: nothing provisioned (or a dev stub) — nothing to release.
      const phoneNumberSid = row?.provider_data?.phoneNumberSid ?? null;
      const phoneE164 = row?.provider_data?.phoneE164 ?? null;
      if (!row?.subaccount_sid || !phoneNumberSid || row.provider_data?.stub === true) {
        logger.info('Twilio number release skipped — no provisioned number', {
          tenantId,
          reason,
        });
        return;
      }

      const masterSid = process.env.TWILIO_ACCOUNT_SID;
      const masterToken = process.env.TWILIO_AUTH_TOKEN;
      const encKey = process.env.TENANT_ENCRYPTION_KEY;
      if (!masterSid || !masterToken || !encKey || !row.auth_token_primary_enc) {
        // Can't reach Twilio without creds. Log + Sentry and move on — this
        // is best-effort cost cleanup, never a hard failure.
        reportReleaseFailure(
          logger,
          tenantId,
          reason,
          new Error('Twilio credentials not configured; cannot release number'),
        );
        return;
      }

      try {
        const authToken = decrypt(row.auth_token_primary_enc, encKey);
        // Idempotent at the Twilio API: releasing an already-released number
        // returns 404, which releasePhoneNumber swallows.
        await releasePhoneNumber(row.subaccount_sid, authToken, phoneNumberSid);

        // Forget the released number so a later re-provision (e.g. the tenant
        // resubscribes) buys a fresh one instead of reusing a dead SID.
        // Status returns to t0_requested ("needs provisioning") — the
        // subaccount and messaging service stay in place (both free), so a
        // resubscribe resumes them instead of creating new ones.
        await tenantQuery(
          pool,
          tenantId,
          `UPDATE tenant_integrations
              SET status = 't0_requested',
                  last_error = NULL,
                  provider_data = provider_data - 'phoneNumberSid' - 'phoneE164' - 'numberAttached',
                  updated_at = NOW()
            WHERE tenant_id = $1 AND provider = 'twilio'`,
          [tenantId]
        );

        // The worker stamps business_phone from the provisioned number; clear
        // it only when it still points at the number we just released, so a
        // manually-changed business line is never clobbered.
        if (phoneE164) {
          await tenantQuery(
            pool,
            tenantId,
            `UPDATE tenant_settings
                SET business_phone = NULL, updated_at = NOW()
              WHERE tenant_id = $1 AND business_phone = $2`,
            [tenantId, phoneE164]
          );
        }

        logger.info('Twilio number released on subscription cancellation', {
          tenantId,
          reason,
          phoneE164,
        });
      } catch (err) {
        // Failure-tolerant: the tenant is already canceled; a Twilio hiccup
        // must not wedge the queue or the webhook path. Logged + Sentry —
        // the operator signal for a number that may still be billing.
        reportReleaseFailure(logger, tenantId, reason, err);
      }
    },
  };
}
