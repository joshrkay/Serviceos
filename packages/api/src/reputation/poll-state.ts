/**
 * P7-026 PR a — Per-tenant poll-state repo + exponential backoff math.
 *
 * `review_poll_state` is a single row per tenant holding the
 * watermark (cursor) for "newest review we've seen" and the
 * exponential-backoff state for 429 throttling.
 *
 * Backoff math lives here (not the worker) so it's unit-testable in
 * isolation:
 *   backoff_until = now + min(2^n * BASE_BACKOFF_MS, MAX_BACKOFF_MS)
 * where n is `consecutive_429_count` *after* increment. First 429
 * sets n=1 (30s), then 60s, 120s, ..., capped at 60min.
 *
 * On any successful poll, both `consecutive_429_count` and
 * `backoff_until` reset — the worker considers a tenant "throttled"
 * iff `now < backoff_until`.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

/** Base step for exponential backoff (first 429 → 30s). */
export const REVIEW_BACKOFF_BASE_MS = 30_000;
/** Hard cap (60 minutes) regardless of consecutive count. */
export const REVIEW_BACKOFF_MAX_MS = 60 * 60_000;

export interface ReviewPollState {
  tenantId: string;
  cursor: string | null;
  lastSuccessfulPollAt: Date | null;
  backoffUntil: Date | null;
  /**
   * Why the current backoff was set: Google throttling (`quota`, clears on
   * its own) or credentials Google rejected (`auth`, needs a reconnect).
   * Null with no backoff, and on rows written before the column existed.
   */
  backoffReason: ReviewBackoffReason | null;
  consecutive429Count: number;
  /**
   * Bumped on every reconnect. A sweep remembers the value it started
   * with, and its "credentials rejected" backoff only lands when no
   * reconnect has happened since, so a sweep still using the old
   * credentials can't pause the new ones.
   */
  authGeneration: number;
  updatedAt: Date;
}

export type ReviewBackoffReason = 'quota' | 'auth';

export interface ReviewPollStateRepository {
  /** Returns null when no row exists for the tenant (first poll). */
  getPollState(tenantId: string): Promise<ReviewPollState | null>;

  /** Persist a successful poll: bump cursor, reset throttling counters. */
  recordSuccess(tenantId: string, newCursor: string): Promise<void>;

  /**
   * D-044 — forget the watermark when the tenant's Google listing changes,
   * so the next poll ingests the new listing from the start. Throttling
   * state is kept (it is per Google account, not per listing).
   */
  resetCursor(tenantId: string): Promise<void>;

  /**
   * The owner reconnected with fresh credentials: bump `authGeneration`
   * (creating the row if needed) and lift a backoff that rejected
   * credentials caused (or one recorded before the reason was). A Google
   * quota backoff is kept. True when one was lifted.
   */
  recordReconnect(tenantId: string): Promise<boolean>;

  /**
   * Persist a 429: increment `consecutive_429_count`, set
   * `backoff_until = now + max(exponential delay, retryAfter)`.
   * Cursor untouched — we'll retry from the same watermark once the
   * backoff lifts.
   *
   * @param retryAfterSeconds  Optional `Retry-After` header value
   *   from the 429 response. Floors the wait — it never shortens the
   *   exponential delay, only extends it when Google asks for more.
   *   The exponential count still increments either way.
   */
  recordQuotaError(tenantId: string, retryAfterSeconds?: number): Promise<void>;

  /**
   * Google rejected the credentials: the same backoff, tagged `auth` so the
   * owner is told to reconnect. Only lands while `authGeneration` is still
   * the value the sweep read before it loaded the credentials; after a
   * reconnect the failure belonged to the old credentials and is dropped.
   * True when recorded.
   */
  recordAuthFailure(
    tenantId: string,
    retryAfterSeconds: number,
    authGeneration: number,
  ): Promise<boolean>;
}

/**
 * Pure: compute the exponential delay (capped) for the Nth
 * consecutive 429. Exported so the worker (and tests) can predict
 * the next retry window without consulting the DB.
 *
 * @param consecutiveCount  the post-increment count (first 429 → 1)
 */
export function computeBackoffMs(consecutiveCount: number): number {
  if (consecutiveCount <= 0) return 0;
  // 2^(n-1) so n=1 → 1 * base = 30s, n=2 → 2 * base = 60s, etc.
  const factor = Math.pow(2, consecutiveCount - 1);
  return Math.min(REVIEW_BACKOFF_BASE_MS * factor, REVIEW_BACKOFF_MAX_MS);
}

/** True iff `now < state.backoffUntil`. Null-safe (no state → not throttled). */
export function isThrottled(
  state: Pick<ReviewPollState, 'backoffUntil'> | null,
  now: Date,
): boolean {
  if (!state || !state.backoffUntil) return false;
  return now.getTime() < state.backoffUntil.getTime();
}

interface PollStateRow {
  tenant_id: string;
  cursor: string | null;
  last_successful_poll_at: string | null;
  backoff_until: string | null;
  backoff_reason: ReviewBackoffReason | null;
  consecutive_429_count: number;
  auth_generation: number;
  updated_at: string;
}

function mapRow(row: PollStateRow): ReviewPollState {
  return {
    tenantId: row.tenant_id,
    cursor: row.cursor,
    lastSuccessfulPollAt: row.last_successful_poll_at
      ? new Date(row.last_successful_poll_at)
      : null,
    backoffUntil: row.backoff_until ? new Date(row.backoff_until) : null,
    backoffReason: row.backoff_reason ?? null,
    consecutive429Count: row.consecutive_429_count,
    authGeneration: row.auth_generation,
    updatedAt: new Date(row.updated_at),
  };
}

export class PgReviewPollStateRepository
  extends PgBaseRepository
  implements ReviewPollStateRepository
{
  constructor(
    pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {
    super(pool);
  }

  async getPollState(tenantId: string): Promise<ReviewPollState | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<PollStateRow>(
        `SELECT tenant_id, cursor, last_successful_poll_at,
                backoff_until, backoff_reason, consecutive_429_count,
                auth_generation, updated_at
           FROM review_poll_state
          WHERE tenant_id = $1`,
        [tenantId],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async recordSuccess(tenantId: string, newCursor: string): Promise<void> {
    const now = this.now();
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO review_poll_state (
           tenant_id, cursor, last_successful_poll_at,
           backoff_until, consecutive_429_count, updated_at
         ) VALUES ($1, $2, $3, NULL, 0, $3)
         ON CONFLICT (tenant_id) DO UPDATE
           SET cursor                  = EXCLUDED.cursor,
               last_successful_poll_at = EXCLUDED.last_successful_poll_at,
               backoff_until           = NULL,
               backoff_reason          = NULL,
               consecutive_429_count   = 0,
               updated_at              = EXCLUDED.updated_at`,
        [tenantId, newCursor, now],
      );
    });
  }

  async resetCursor(tenantId: string): Promise<void> {
    const now = this.now();
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE review_poll_state SET cursor = NULL, updated_at = $2 WHERE tenant_id = $1`,
        [tenantId, now],
      );
    });
  }

  async recordReconnect(tenantId: string): Promise<boolean> {
    const now = this.now();
    return this.withTenant(tenantId, async (client) => {
      const prev = await client.query<{ lifted: boolean }>(
        `SELECT (backoff_until IS NOT NULL AND backoff_reason IS DISTINCT FROM 'quota') AS lifted
           FROM review_poll_state WHERE tenant_id = $1 FOR UPDATE`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO review_poll_state (
           tenant_id, cursor, last_successful_poll_at,
           backoff_until, consecutive_429_count, updated_at, auth_generation
         ) VALUES ($1, NULL, NULL, NULL, 0, $2, 1)
         ON CONFLICT (tenant_id) DO UPDATE
           SET auth_generation = review_poll_state.auth_generation + 1,
               backoff_until = CASE WHEN review_poll_state.backoff_reason = 'quota'
                                    THEN review_poll_state.backoff_until END,
               consecutive_429_count = CASE WHEN review_poll_state.backoff_reason = 'quota'
                                            THEN review_poll_state.consecutive_429_count ELSE 0 END,
               backoff_reason = CASE WHEN review_poll_state.backoff_reason = 'quota'
                                     THEN review_poll_state.backoff_reason END,
               updated_at = $2`,
        [tenantId, now],
      );
      return prev.rows[0]?.lifted ?? false;
    });
  }

  async recordQuotaError(tenantId: string, retryAfterSeconds?: number): Promise<void> {
    await this.recordBackoff(tenantId, retryAfterSeconds, 'quota', null);
  }

  async recordAuthFailure(
    tenantId: string,
    retryAfterSeconds: number,
    authGeneration: number,
  ): Promise<boolean> {
    return this.recordBackoff(tenantId, retryAfterSeconds, 'auth', authGeneration);
  }

  /** A null `authGeneration` records unconditionally. */
  private async recordBackoff(
    tenantId: string,
    retryAfterSeconds: number | undefined,
    reason: ReviewBackoffReason,
    authGeneration: number | null,
  ): Promise<boolean> {
    const now = this.now();
    // `Retry-After` floors the wait but never shortens the exponential
    // delay. The SQL uses GREATEST(exponential, retryAfterMs) so the
    // header only matters when it asks for a LONGER wait than our
    // backoff. A missing / non-positive header passes 0 to GREATEST,
    // which is a no-op.
    const retryAfterMs =
      retryAfterSeconds !== undefined && retryAfterSeconds > 0
        ? Math.floor(retryAfterSeconds * 1000)
        : 0;
    return this.withTenant(tenantId, async (client) => {
      // Single round-trip: compute next count + backoff in SQL so we
      // never race with a concurrent worker tick (there shouldn't be
      // one — single-process interval driver — but defense in depth).
      // The arithmetic mirrors computeBackoffMs() above; keep them in
      // sync if either changes.
      // A reconnect since the sweep started (auth_generation moved, or a
      // row now exists where the sweep saw none) drops the write.
      const result = await client.query(
        `INSERT INTO review_poll_state (
           tenant_id, cursor, last_successful_poll_at,
           backoff_until, consecutive_429_count, updated_at, backoff_reason
         ) VALUES (
           $1, NULL, NULL,
           $2::timestamptz + (GREATEST(
             LEAST(
               $3::bigint * POWER(2, 0)::bigint,
               $4::bigint
             ),
             $5::bigint
           ) || ' milliseconds')::interval,
           1, $2, $6
         )
         ON CONFLICT (tenant_id) DO UPDATE
           SET consecutive_429_count = review_poll_state.consecutive_429_count + 1,
               backoff_reason        = $6,
               backoff_until         = $2::timestamptz + (GREATEST(
                 LEAST(
                   ($3::bigint * POWER(2, review_poll_state.consecutive_429_count)::bigint),
                   $4::bigint
                 ),
                 $5::bigint
               ) || ' milliseconds')::interval,
               updated_at            = $2
           WHERE $7::int IS NULL OR review_poll_state.auth_generation = $7::int`,
        [
          tenantId,
          now,
          REVIEW_BACKOFF_BASE_MS,
          REVIEW_BACKOFF_MAX_MS,
          retryAfterMs,
          reason,
          authGeneration,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }
}

/**
 * In-memory test double — same semantics as the PG repo, no DB.
 * Used by the worker tests and downstream PR b/c tests.
 */
export class InMemoryReviewPollStateRepository
  implements ReviewPollStateRepository
{
  private readonly store = new Map<string, ReviewPollState>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async getPollState(tenantId: string): Promise<ReviewPollState | null> {
    return this.store.get(tenantId) ?? null;
  }

  async recordSuccess(tenantId: string, newCursor: string): Promise<void> {
    const now = this.now();
    this.store.set(tenantId, {
      tenantId,
      cursor: newCursor,
      lastSuccessfulPollAt: now,
      backoffUntil: null,
      backoffReason: null,
      consecutive429Count: 0,
      authGeneration: this.store.get(tenantId)?.authGeneration ?? 0,
      updatedAt: now,
    });
  }

  async resetCursor(tenantId: string): Promise<void> {
    const existing = this.store.get(tenantId);
    if (!existing) return;
    this.store.set(tenantId, { ...existing, cursor: null, updatedAt: this.now() });
  }

  async recordReconnect(tenantId: string): Promise<boolean> {
    const existing = this.store.get(tenantId);
    const lifted = !!existing?.backoffUntil && existing.backoffReason !== 'quota';
    const keepQuota = existing?.backoffReason === 'quota';
    this.store.set(tenantId, {
      tenantId,
      cursor: existing?.cursor ?? null,
      lastSuccessfulPollAt: existing?.lastSuccessfulPollAt ?? null,
      backoffUntil: keepQuota ? existing!.backoffUntil : null,
      backoffReason: keepQuota ? 'quota' : null,
      consecutive429Count: keepQuota ? existing!.consecutive429Count : 0,
      authGeneration: (existing?.authGeneration ?? 0) + 1,
      updatedAt: this.now(),
    });
    return lifted;
  }

  async recordQuotaError(tenantId: string, retryAfterSeconds?: number): Promise<void> {
    this.recordBackoff(tenantId, retryAfterSeconds, 'quota', null);
  }

  async recordAuthFailure(
    tenantId: string,
    retryAfterSeconds: number,
    authGeneration: number,
  ): Promise<boolean> {
    return this.recordBackoff(tenantId, retryAfterSeconds, 'auth', authGeneration);
  }

  private recordBackoff(
    tenantId: string,
    retryAfterSeconds: number | undefined,
    reason: ReviewBackoffReason,
    authGeneration: number | null,
  ): boolean {
    const now = this.now();
    const existing = this.store.get(tenantId);
    if (authGeneration !== null && (existing?.authGeneration ?? 0) !== authGeneration) {
      return false;
    }
    const nextCount = (existing?.consecutive429Count ?? 0) + 1;
    const exponentialMs = computeBackoffMs(nextCount);
    const retryAfterMs =
      retryAfterSeconds !== undefined && retryAfterSeconds > 0
        ? Math.floor(retryAfterSeconds * 1000)
        : 0;
    // GREATEST: header only floors the wait, never shortens the
    // exponential backoff. Mirrors the SQL branch above.
    const delay = Math.max(exponentialMs, retryAfterMs);
    this.store.set(tenantId, {
      tenantId,
      cursor: existing?.cursor ?? null,
      lastSuccessfulPollAt: existing?.lastSuccessfulPollAt ?? null,
      backoffUntil: new Date(now.getTime() + delay),
      backoffReason: reason,
      consecutive429Count: nextCount,
      authGeneration: existing?.authGeneration ?? 0,
      updatedAt: now,
    });
    return true;
  }
}
