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
 * claimed_at < now() - staleInterval`. Crucially, that reclaim WHERE clause
 * only ever matches `status = 'claimed'` rows.
 *
 * Three states, not two:
 *  - 'claimed'  — reserved, the provider has NOT been called yet. Safe to
 *                 stale-reclaim: nothing was sent, so a reclaim + resend
 *                 cannot duplicate anything.
 *  - 'sending'  — the provider call is in flight (or the process crashed
 *                 while it was). NEVER auto-reclaimed by `claimSend`,
 *                 regardless of age — a resend here could duplicate a
 *                 provider send that already went out. This is the fix for
 *                 the post-send crash window: previously a crash between the
 *                 provider send succeeding and the 'sent' tombstone commit
 *                 left the row at 'claimed', which the stale window WOULD
 *                 reclaim, causing a later sweep to re-send. Landing in
 *                 'sending' first closes that window at the cost of a
 *                 possibly-stuck (never auto-resolved) row — an intentional
 *                 tradeoff over a silent duplicate send. See
 *                 `findStuckSendClaims` for surfacing (not resolving) these.
 *  - 'sent'     — permanent tombstone. Once here, `claimSend`'s WHERE clause
 *                 can never match the row again regardless of age.
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
 * `staleMinutes`. Returns false when another (still-fresh) claim, an
 * in-flight `status = 'sending'` row, or a permanent `status = 'sent'`
 * tombstone already owns the key.
 *
 * The WHERE clause below intentionally matches ONLY `status = 'claimed'` —
 * never `'sending'`. A `'sending'` row means a provider call may already be
 * in flight (or may have already completed before a crash), so reclaiming it
 * on a timer risks a duplicate send. It is never automatically reclaimed;
 * see `findStuckSendClaims` for surfacing (not resolving) rows stuck there.
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
 * Transition a freshly-claimed row to 'sending' — the provider call is about
 * to start. Scoped to `status = 'claimed'` so this only ever advances a row
 * this process itself just claimed. Once this commits, `claimSend` can never
 * reclaim the row again on a timer (see the module doc for why).
 */
export async function markSendClaimSending(
  pool: Pool,
  tenantId: string,
  claimKey: string,
): Promise<void> {
  await pool.query(
    `UPDATE send_claims SET status = 'sending'
     WHERE tenant_id = $1 AND claim_key = $2 AND status = 'claimed'`,
    [tenantId, claimKey],
  );
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
 * Deletes a `'claimed'` OR `'sending'` row — both are states this process
 * itself owns after a CAUGHT, pre-completion failure (a claim with no send
 * attempted yet, or a send attempt that threw before/while calling the
 * provider). A late/duplicate release call after a completed send can never
 * undo the `'sent'` tombstone, since that status is excluded here.
 *
 * This is deliberately more permissive than `claimSend`'s automatic
 * stale-reclaim WHERE clause: releasing a `'sending'` row here is safe
 * because it only happens when THIS process's own `sendFn` threw (so it
 * knows, first-hand, that the provider call did not succeed) — never as a
 * blind timer-based guess the way `claimSend`'s reclaim is.
 */
export async function releaseSendClaim(
  pool: Pool,
  tenantId: string,
  claimKey: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM send_claims
     WHERE tenant_id = $1 AND claim_key = $2 AND status IN ('claimed', 'sending')`,
    [tenantId, claimKey],
  );
}

/**
 * Surfaces rows genuinely stuck at 'sending' — the process crashed between
 * the sending UPDATE and either the completion write or a caught-error
 * release. These are NEVER auto-reclaimed (see module doc) and this helper
 * does NOT resolve them either; it only reports so a future monitor/operator
 * can decide (confirm the provider send actually happened, then manually
 * mark 'sent'; or manually release for a resend). Do not wire this into any
 * path that silently resolves these rows.
 */
export async function findStuckSendClaims(
  pool: Pool,
  olderThanMinutes: number,
): Promise<Array<{ tenantId: string; claimKey: string; claimedAt: Date }>> {
  const res = await pool.query(
    `SELECT tenant_id, claim_key, claimed_at FROM send_claims
     WHERE status = 'sending'
       AND claimed_at < NOW() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return res.rows.map((row) => ({
    tenantId: row.tenant_id,
    claimKey: row.claim_key,
    claimedAt: row.claimed_at,
  }));
}

export type SendClaimOutcome<T> =
  | { outcome: 'sent'; result: T }
  | {
      /**
       * Claim miss. `priorStatus` says why: `'sent'` — permanent tombstone,
       * this occasion completed earlier; `'claimed'` — another process holds
       * a still-fresh pre-send claim (a pre-send crash that the stale window
       * will reclaim); `'sending'` — another process's provider call is in
       * flight, or crashed mid-flight (never auto-reclaimed); `'unknown'` —
       * the row vanished between the claim attempt and the status read (a
       * concurrent release). Callers that branch on `priorStatus !== 'sent'`
       * correctly group `'sending'` with `'claimed'` into the same
       * "in-flight, not a crash" bucket.
       */
      outcome: 'duplicate';
      priorStatus: 'sent' | 'claimed' | 'sending' | 'unknown';
    };

/**
 * Compose claim → sending → send → finalize/release. Mirrors
 * `sendLifecycleEmail`'s shape: claim first; on a claim-miss, skip `sendFn`
 * entirely and report `'duplicate'` (with the losing claim's `priorStatus`,
 * so callers can tell a completed/in-flight send from a reclaimable one);
 * otherwise transition the claim to `'sending'` BEFORE invoking `sendFn` —
 * this is the crash-safety fix: if the process dies after the provider call
 * succeeds but before `markSendClaimComplete` commits, the row is already at
 * `'sending'`, which `claimSend` never auto-reclaims, so a later sweep can't
 * re-send it.
 *
 * `sendFn` receives a `markProviderAccepted()` signal (Codex P1 #2 follow-up
 * to the crash-safety fix above). `sendFn` should call it the instant the
 * PROVIDER has accepted the message — before any post-send bookkeeping the
 * closure also happens to perform. This closes a second, narrower window than
 * the 'sending' state does: a caught (not crashed) exception from
 * post-provider-acceptance bookkeeping (e.g. a `dispatchRepo.create` or an
 * entity-status write throwing after the SMS/email genuinely went out). Most
 * callers should instead do that bookkeeping AFTER `withSendClaim` returns
 * `{outcome: 'sent', result}` (see notifications/customer-message-delivery.ts)
 * so it's structurally impossible to trigger this path — `markProviderAccepted`
 * exists for callers where the bookkeeping is buried inside a shared method
 * they don't own end-to-end (see estimates/estimate-nudge.ts wrapping
 * `SendService.sendEstimate`, which threads it through as an option).
 *
 * On `sendFn` throwing:
 *   - if `markProviderAccepted` was never called (the process is still alive,
 *     so we know first-hand the provider call itself did not succeed):
 *     release the claim, then rethrow unchanged (the caller's existing
 *     try/catch owns retry semantics).
 *   - if `markProviderAccepted` WAS called before the throw (the provider
 *     already accepted the message — only the caller's own follow-up
 *     bookkeeping failed): finalize the claim to the permanent `'sent'`
 *     tombstone instead of releasing it, then rethrow unchanged. A resend
 *     here would duplicate a message that already went out; the caller's own
 *     catch still sees the bookkeeping error so it can log/reconcile.
 *
 * On success, finalize the claim to the permanent `'sent'` tombstone and
 * return the send result.
 */
export async function withSendClaim<T>(
  pool: Pool,
  tenantId: string,
  claimKey: string,
  sendFn: (markProviderAccepted: () => void) => Promise<T>,
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
      priorStatus:
        status === 'sent' || status === 'claimed' || status === 'sending' ? status : 'unknown',
    };
  }

  let providerAccepted = false;
  const markProviderAccepted = () => {
    providerAccepted = true;
  };

  let result: T;
  try {
    // Flip to 'sending' BEFORE the provider call so a crash after a
    // successful send can never be mistaken for an abandoned pre-send claim
    // (see module doc + claimSend's WHERE clause).
    await markSendClaimSending(pool, tenantId, claimKey);
    result = await sendFn(markProviderAccepted);
  } catch (err) {
    if (providerAccepted) {
      // The provider already accepted the message before this error — only
      // sendFn's post-send bookkeeping threw. Finalize (never release): a
      // released claim here would let a retry duplicate a send that already
      // went out. The bookkeeping error still propagates unchanged so the
      // caller's own catch can log/reconcile it.
      await markSendClaimComplete(pool, tenantId, claimKey).catch(() => undefined);
      throw err;
    }
    await releaseSendClaim(pool, tenantId, claimKey).catch(() => undefined);
    throw err;
  }

  await markSendClaimComplete(pool, tenantId, claimKey);
  return { outcome: 'sent', result };
}
