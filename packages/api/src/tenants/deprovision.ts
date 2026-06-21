import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import { decrypt } from '../integrations/crypto';
import {
  releasePhoneNumber as realReleasePhoneNumber,
  closeSubaccount as realCloseSubaccount,
} from '../integrations/twilio/provisioning';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres identifier guard for the dynamically-discovered table names.
const IDENT_REGEX = /^[a-z_][a-z0-9_]*$/;

export type DeprovisionReason =
  | 'manual_admin'
  | 'owner_self_serve'
  | 'stripe_subscription_deleted'
  | 'stripe_subscription_canceled';

export interface DeprovisionInput {
  tenantId: string;
  reason: DeprovisionReason;
  actorId: string;
  /**
   * Purge the database even if the Twilio subaccount could not be released.
   * Without this, a Twilio failure on the `manual_admin` path aborts before
   * the purge so we don't lose the subaccount SID we still need to close.
   */
  force?: boolean;
}

export interface DeprovisionResult {
  tenantId: string;
  /** True when the tenant was already gone — a no-op (idempotent). */
  alreadyPurged: boolean;
  twilioReleased: boolean;
  twilioError?: string;
  rowsDeletedByTable: Record<string, number>;
}

export interface DeprovisionDeps {
  pool: Pool;
  logger: Logger;
  // Injectable for testing; defaults to the real Twilio helpers.
  twilio?: {
    releasePhoneNumber: typeof realReleasePhoneNumber;
    closeSubaccount: typeof realCloseSubaccount;
  };
}

interface TwilioIntegrationRow {
  subaccountSid: string | null;
  authTokenEnc: string | null;
  phoneNumberSid: string | null;
}

async function readTwilioIntegration(
  pool: Pool,
  tenantId: string,
): Promise<TwilioIntegrationRow | null> {
  // tenant_integrations is FORCE RLS — read it under the tenant's own GUC in a
  // short transaction (matches the worker pattern), so this works without
  // relying on the connection role bypassing RLS.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    const { rows } = await client.query<{
      subaccount_sid: string | null;
      auth_token_primary_enc: string | null;
      provider_data: { phoneNumberSid?: string } | null;
    }>(
      `SELECT subaccount_sid, auth_token_primary_enc, provider_data
         FROM tenant_integrations
        WHERE tenant_id = $1 AND provider = 'twilio'
        LIMIT 1`,
      [tenantId],
    );
    await client.query('COMMIT');
    if (rows.length === 0) return null;
    return {
      subaccountSid: rows[0].subaccount_sid,
      authTokenEnc: rows[0].auth_token_primary_enc,
      phoneNumberSid: rows[0].provider_data?.phoneNumberSid ?? null,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Hard-deletes a tenant: releases its Twilio subaccount, then purges every
 * tenant-scoped row from the database (all tables carrying a `tenant_id`
 * column, per the project's core RLS pattern), then the `tenants` row itself.
 * Finally writes a durable record to `platform_deprovision_log` (which is not
 * tenant-scoped, so it survives the purge).
 *
 * Idempotent: a missing tenant returns `{ alreadyPurged: true }`.
 *
 * Requires a database connection whose role can `SET session_replication_role`
 * (e.g. the migration/admin role). Replica mode disables FK triggers (so the
 * deletes need no dependency ordering) and RLS (so FORCE-RLS tables can be
 * purged).
 */
export async function deprovisionTenant(
  deps: DeprovisionDeps,
  input: DeprovisionInput,
): Promise<DeprovisionResult> {
  const { pool, logger } = deps;
  const { tenantId, reason, actorId } = input;
  const twilio = deps.twilio ?? {
    releasePhoneNumber: realReleasePhoneNumber,
    closeSubaccount: realCloseSubaccount,
  };

  if (!UUID_REGEX.test(tenantId)) {
    throw new Error('Invalid tenant ID format: must be a valid UUID');
  }

  const existsRes = await pool.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
  if (existsRes.rowCount === 0) {
    logger.info('Deprovision no-op — tenant already gone', { tenantId });
    return { tenantId, alreadyPurged: true, twilioReleased: false, rowsDeletedByTable: {} };
  }

  // 1 — Release Twilio FIRST, before the SID is destroyed by the purge.
  let twilioReleased = false;
  let twilioError: string | undefined;
  let subaccountSid: string | null = null;

  const integ = await readTwilioIntegration(pool, tenantId);
  subaccountSid = integ?.subaccountSid ?? null;
  if (subaccountSid) {
    const encKey = process.env.TENANT_ENCRYPTION_KEY;
    const masterSid = process.env.TWILIO_ACCOUNT_SID;
    const masterToken = process.env.TWILIO_AUTH_TOKEN;
    if (encKey && masterSid && masterToken && integ?.authTokenEnc) {
      try {
        const authToken = decrypt(integ.authTokenEnc, encKey);
        if (integ.phoneNumberSid) {
          await twilio.releasePhoneNumber(subaccountSid, authToken, integ.phoneNumberSid);
        }
        await twilio.closeSubaccount(masterSid, masterToken, subaccountSid);
        twilioReleased = true;
      } catch (err) {
        twilioError = err instanceof Error ? err.message : String(err);
      }
    } else {
      twilioError = 'Twilio credentials not configured';
    }

    if (!twilioReleased && !input.force && reason === 'manual_admin') {
      throw new Error(
        `Twilio release failed for tenant ${tenantId} (${twilioError}); ` +
          'rerun with force=true to purge the database anyway.',
      );
    }
  }

  // 2 — Purge every tenant-scoped table, then the tenant row, in one
  // transaction with FK triggers + RLS disabled.
  const rowsDeletedByTable: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");

    const tablesRes = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
        ORDER BY table_name`,
    );

    for (const { table_name } of tablesRes.rows) {
      if (!IDENT_REGEX.test(table_name)) {
        throw new Error(`Refusing to purge unsafe table name: ${table_name}`);
      }
      const res = await client.query(
        `DELETE FROM "${table_name}" WHERE tenant_id = $1`,
        [tenantId],
      );
      rowsDeletedByTable[table_name] = res.rowCount ?? 0;
    }

    const tenantRes = await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    rowsDeletedByTable['tenants'] = tenantRes.rowCount ?? 0;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // 3 — Durable record (survives the purge: no tenant FK, no RLS).
  await pool.query(
    `INSERT INTO platform_deprovision_log
       (tenant_id, reason, actor_id, twilio_released, twilio_subaccount_sid, twilio_error, rows_deleted)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      tenantId,
      reason,
      actorId,
      twilioReleased,
      subaccountSid,
      twilioError ?? null,
      JSON.stringify(rowsDeletedByTable),
    ],
  );

  const totalRows = Object.values(rowsDeletedByTable).reduce((a, b) => a + b, 0);
  logger.info('Tenant deprovisioned', {
    tenantId,
    reason,
    actorId,
    twilioReleased,
    twilioError,
    totalRowsDeleted: totalRows,
  });

  return { tenantId, alreadyPurged: false, twilioReleased, twilioError, rowsDeletedByTable };
}
