/**
 * #1575 — orphaned Twilio number sweeper.
 *
 * A change-number (#1563, workers/change-twilio-number.ts) releases the old
 * number only AFTER repointing the tenant; if that release fails the tenant
 * keeps paying for two numbers, recorded as `provider_data.orphanedNumberSid`.
 * (The rollback path records a half-bought new number the same way.) This
 * periodic sweep (async worker pattern, P0-009 — driven from app.ts by a
 * leader-locked setInterval) retries the release:
 *
 *   - runs per tenant under the SAME advisory lock as the provisioning worker,
 *     so it never interleaves with a change-number mid-repoint (contended →
 *     skipped, retried next tick);
 *   - never releases the tenant's ACTIVE number (`phoneNumberSid`);
 *   - clears the marker on success (a Twilio 404 = already released =
 *     success), only if the marker still names the sid it released;
 *   - counts failures in `orphanedNumberReleaseFailures` and pages the
 *     operator through alertOperator once they reach `alertAfterFailures`.
 *
 * Never throws: one tenant's failure never aborts the sweep.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import type { AlertOperatorFn } from '../monitoring/alert-operator';
import { decrypt } from '../integrations/crypto';
import { releasePhoneNumber } from '../integrations/twilio/provisioning';
import { tenantQuery } from './tenant-query';
import { tryWithTenantPhoneLock } from './provision-twilio';

export const ORPHANED_NUMBER_ALERT_AFTER_FAILURES = 5;

export interface OrphanedNumberSweepDeps {
  pool: Pool;
  listTenantIds: () => Promise<string[]>;
  encKey: string;
  alert: AlertOperatorFn;
  logger: Logger;
  /** Default {@link ORPHANED_NUMBER_ALERT_AFTER_FAILURES}. */
  alertAfterFailures?: number;
}

export async function runOrphanedNumberSweep(deps: OrphanedNumberSweepDeps): Promise<void> {
  const { pool, logger } = deps;
  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    logger.error('Orphaned-number sweep: listing tenants failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  for (const tenantId of tenantIds) {
    try {
      await tryWithTenantPhoneLock(pool, tenantId, () => sweepTenant(deps, tenantId));
    } catch (err) {
      logger.error('Orphaned-number sweep failed for tenant', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function sweepTenant(deps: OrphanedNumberSweepDeps, tenantId: string): Promise<void> {
  const { pool, encKey } = deps;
  const { rows } = await tenantQuery<{
    subaccount_sid: string | null;
    auth_token_primary_enc: string | null;
    orphaned_sid: string | null;
    active_sid: string | null;
  }>(
    pool,
    tenantId,
    `SELECT subaccount_sid, auth_token_primary_enc,
            provider_data->>'orphanedNumberSid' AS orphaned_sid,
            provider_data->>'phoneNumberSid' AS active_sid
       FROM tenant_integrations
      WHERE tenant_id = $1 AND provider = 'twilio'
        AND provider_data ? 'orphanedNumberSid'`,
    [tenantId],
  );
  const row = rows[0];
  if (!row?.orphaned_sid) return;
  const orphanedSid = row.orphaned_sid;

  // Never release the line the tenant is on. A marker naming it is stale
  // (e.g. the owner changed back to that number and it was reused): drop it.
  if (orphanedSid === row.active_sid) {
    deps.logger.warn('Orphaned-number marker names the ACTIVE number — cleared, not released', {
      tenantId,
      phoneNumberSid: orphanedSid,
    });
    await clearMarker(pool, tenantId, orphanedSid);
    return;
  }
  if (!row.subaccount_sid || !row.auth_token_primary_enc) return;
  const authToken = decrypt(row.auth_token_primary_enc, encKey);
  try {
    await releasePhoneNumber(row.subaccount_sid, authToken, orphanedSid);
  } catch (err) {
    await recordFailure(deps, tenantId, orphanedSid, err);
    return;
  }
  await clearMarker(pool, tenantId, orphanedSid);
  deps.logger.info('Released orphaned Twilio number', { tenantId, phoneNumberSid: orphanedSid });
}

async function recordFailure(
  deps: OrphanedNumberSweepDeps,
  tenantId: string,
  sid: string,
  err: unknown,
): Promise<void> {
  const error = err instanceof Error ? err.message : String(err);
  const { rows } = await tenantQuery<{ failures: number }>(
    deps.pool,
    tenantId,
    `UPDATE tenant_integrations
        SET provider_data = provider_data || jsonb_build_object(
              'orphanedNumberReleaseFailures',
              COALESCE((provider_data->>'orphanedNumberReleaseFailures')::int, 0) + 1),
            updated_at = NOW()
      WHERE tenant_id = $1 AND provider = 'twilio'
        AND provider_data->>'orphanedNumberSid' = $2
      RETURNING (provider_data->>'orphanedNumberReleaseFailures')::int AS failures`,
    [tenantId, sid],
  );
  const failures = rows[0]?.failures ?? 0;
  deps.logger.error('Releasing orphaned Twilio number FAILED — will retry next sweep', {
    tenantId,
    phoneNumberSid: sid,
    failures,
    error,
  });
  // Page once, when the threshold is crossed; later failures keep retrying
  // (and logging) without re-paging.
  if (failures === (deps.alertAfterFailures ?? ORPHANED_NUMBER_ALERT_AFTER_FAILURES)) {
    await deps.alert({
      severity: 'warning',
      // Per-number rule key: alertOperator's cooldown is per rule, so a shared
      // key would swallow a second tenant's page inside the cooldown window.
      rule: `orphaned_number_release:${sid}`,
      summary: `Could not release an orphaned Twilio number after ${failures} attempts — the tenant is paying for two numbers; release it by hand`,
      details: { tenantId, phoneNumberSid: sid, failures },
    });
  }
}

/** Clear the marker only if it still names `sid` (a newer orphan survives). */
async function clearMarker(pool: Pool, tenantId: string, sid: string): Promise<void> {
  await tenantQuery(
    pool,
    tenantId,
    `UPDATE tenant_integrations
        SET provider_data = provider_data - 'orphanedNumberSid' - 'orphanedNumberReleaseFailures',
            updated_at = NOW()
      WHERE tenant_id = $1 AND provider = 'twilio'
        AND provider_data->>'orphanedNumberSid' = $2`,
    [tenantId, sid],
  );
}
