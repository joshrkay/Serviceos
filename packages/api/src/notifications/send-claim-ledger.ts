/**
 * T4-F01 — shared claim-before-send primitive for mark-after-send workers.
 *
 * Generalizes `lifecycle-email.ts`'s claim/release idiom (migration 204,
 * `lifecycle_emails`) into a reusable ledger backing every recurring,
 * customer-facing send path (thank-you SMS, estimate nudges, generic
 * transactional comms). The `send_claims` table (migration 258) is the gate:
 * one row per (tenant_id, claim_key).
 *
 * Unlike `lifecycle_emails` (a ONE-TIME onboarding email, where a claim that
 * never resolves is an acceptable, permanent no-op), these are recurring,
 * revenue-adjacent touchpoints — an abandoned claim (crash before the send
 * even started) must not block the message forever. So `claimSend` is a
 * bounded stale-claim reclaim: `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE
 * claimed_at < now() - staleInterval`. A `status = 'sent'` row is a permanent
 * tombstone — the WHERE clause only ever matches `status = 'claimed'` rows,
 * so a completed send can never be reclaimed regardless of age.
 *
 * This module is purely the crash-safety layer. It does not replace or
 * duplicate a caller's existing business-level completion fields
 * (`jobs.thank_you_sms_sent_at`, `estimates.reminder_count`,
 * `message_dispatches` rows) — those keep their current meaning and are
 * still written only after a confirmed successful send.
 */
import type { Pool } from 'pg';

/** Default window after which an unresolved 'claimed' row is reclaimable. */
const DEFAULT_STALE_MINUTES = 15;

/**
 * Atomically claim `claimKey` for `tenantId`. Returns true iff this call now
 * owns the right to send: either a fresh row was inserted, or an existing
 * `status = 'claimed'` row was reclaimed because it sat unresolved past
 * `staleMinutes`. Returns false when another (still-fresh) claim or a
 * permanent `status = 'sent'` tombstone already owns the key.
 */
export async function claimSend(
  pool: Pool,
  tenantId: string,
  claimKey: string,
  staleMinutes: number = DEFAULT_STALE_MINUTES,
): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
     VALUES ($1, $2, 'claimed', NOW())
     ON CONFLICT (tenant_id, claim_key) DO UPDATE
       SET claimed_at = NOW(), status = 'claimed'
       WHERE send_claims.status = 'claimed'
         AND send_claims.claimed_at < NOW() - ($3 || ' minutes')::interval
     RETURNING claim_key`,
    [tenantId, claimKey, String(staleMinutes)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Permanently finalize a claim as sent. Idempotent; once a row is `'sent'`,
 * `claimSend`'s guard means it is never matched again for this key.
 */
export async function markSendClaimComplete(
  pool: Pool,
  tenantId: string,
  claimKey: string,
): Promise<void> {
  await pool.query(
    `UPDATE send_claims SET status = 'sent', sent_at = NOW()
     WHERE tenant_id = $1 AND claim_key = $2`,
    [tenantId, claimKey],
  );
}

/**
 * Release a previously-claimed row so the next attempt can re-claim + send.
 * Only ever deletes a `status = 'claimed'` row — a late/duplicate release
 * call after a completed send can never undo the `'sent'` tombstone.
 */
export async function releaseSendClaim(
  pool: Pool,
  tenantId: string,
  claimKey: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM send_claims WHERE tenant_id = $1 AND claim_key = $2 AND status = 'claimed'`,
    [tenantId, claimKey],
  );
}

export type SendClaimOutcome<T> =
  | { outcome: 'sent'; result: T }
  | {
      /**
       * Claim miss. `priorStatus` says why: `'sent'` — permanent tombstone,
       * this occasion completed earlier; `'claimed'` — another process holds
       * a still-fresh claim (in flight, or a pre-send crash that the stale
       * window will reclaim); `'unknown'` — the row vanished between the
       * claim attempt and the status read (a concurrent release).
       */
      outcome: 'duplicate';
      priorStatus: 'sent' | 'claimed' | 'unknown';
    };

/**
 * Compose claim → send → finalize/release. Mirrors `sendLifecycleEmail`'s
 * shape: claim first; on a claim-miss, skip `sendFn` entirely and report
 * `'duplicate'` (with the losing claim's `priorStatus`, so callers can tell
 * a completed send from an in-flight one); on `sendFn` throwing, release the
 * claim then rethrow unchanged (the caller's existing try/catch owns retry
 * semantics); on success, finalize the claim to the permanent `'sent'`
 * tombstone and return the send result.
 */
export async function withSendClaim<T>(
  pool: Pool,
  tenantId: string,
  claimKey: string,
  sendFn: () => Promise<T>,
  staleMinutes: number = DEFAULT_STALE_MINUTES,
): Promise<SendClaimOutcome<T>> {
  const claimed = await claimSend(pool, tenantId, claimKey, staleMinutes);
  if (!claimed) {
    const res = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenantId, claimKey],
    );
    const status = res.rows[0]?.status;
    return {
      outcome: 'duplicate',
      priorStatus: status === 'sent' || status === 'claimed' ? status : 'unknown',
    };
  }

  let result: T;
  try {
    result = await sendFn();
  } catch (err) {
    await releaseSendClaim(pool, tenantId, claimKey).catch(() => undefined);
    throw err;
  }

  await markSendClaimComplete(pool, tenantId, claimKey);
  return { outcome: 'sent', result };
}
