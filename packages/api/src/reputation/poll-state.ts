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
  consecutive429Count: number;
  updatedAt: Date;
}

export interface ReviewPollStateRepository {
  /** Returns null when no row exists for the tenant (first poll). */
  getPollState(tenantId: string): Promise<ReviewPollState | null>;

  /** Persist a successful poll: bump cursor, reset throttling counters. */
  recordSuccess(tenantId: string, newCursor: string): Promise<void>;

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
  recordQuotaError(
    tenantId: string,
    retryAfterSeconds?: number,
  ): Promise<void>;
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
  state: ReviewPollState | null,
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
  consecutive_429_count: number;
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
    consecutive429Count: row.consecutive_429_count,
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
                backoff_until, consecutive_429_count, updated_at
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
               consecutive_429_count   = 0,
               updated_at              = EXCLUDED.updated_at`,
        [tenantId, newCursor, now],
      );
    });
  }

  async recordQuotaError(
    tenantId: string,
    retryAfterSeconds?: number,
  ): Promise<void> {
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
    await this.withTenant(tenantId, async (client) => {
      // Single round-trip: compute next count + backoff in SQL so we
      // never race with a concurrent worker tick (there shouldn't be
      // one — single-process interval driver — but defense in depth).
      // The arithmetic mirrors computeBackoffMs() above; keep them in
      // sync if either changes.
      await client.query(
        `INSERT INTO review_poll_state (
           tenant_id, cursor, last_successful_poll_at,
           backoff_until, consecutive_429_count, updated_at
         ) VALUES (
           $1, NULL, NULL,
           $2::timestamptz + (GREATEST(
             LEAST(
               $3::bigint * POWER(2, 0)::bigint,
               $4::bigint
             ),
             $5::bigint
           ) || ' milliseconds')::interval,
           1, $2
         )
         ON CONFLICT (tenant_id) DO UPDATE
           SET consecutive_429_count = review_poll_state.consecutive_429_count + 1,
               backoff_until         = $2::timestamptz + (GREATEST(
                 LEAST(
                   ($3::bigint * POWER(2, review_poll_state.consecutive_429_count)::bigint),
                   $4::bigint
                 ),
                 $5::bigint
               ) || ' milliseconds')::interval,
               updated_at            = $2`,
        [
          tenantId,
          now,
          REVIEW_BACKOFF_BASE_MS,
          REVIEW_BACKOFF_MAX_MS,
          retryAfterMs,
        ],
      );
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
      consecutive429Count: 0,
      updatedAt: now,
    });
  }

  async recordQuotaError(
    tenantId: string,
    retryAfterSeconds?: number,
  ): Promise<void> {
    const now = this.now();
    const existing = this.store.get(tenantId);
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
      consecutive429Count: nextCount,
      updatedAt: now,
    });
  }
}
