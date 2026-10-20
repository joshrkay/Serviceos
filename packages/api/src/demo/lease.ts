/**
 * U7 (S6-3) — the demo tenant lease (plan "One live call per tenant").
 *
 * Every demo call holds exactly one demo tenant of its trade, so two
 * visitors never share an account's rows. The lease is taken as the second
 * write of the start transaction (after the visitor's allowance): the
 * tenant is picked `FOR UPDATE SKIP LOCKED` among the trade's demo tenants
 * with no unreleased lease, and the two partial unique indexes on
 * `released_at IS NULL` (per tenant, per visitor hash) are the backstop.
 *
 * The timing constants live here and nowhere else. The lease is inserted
 * with only the pre-live window (the `Calls` request's bound, the ring
 * timeout and grace: 70 s), because nothing yet proves the call is live;
 * the first `ringing` or `in-progress` callback renews it once to that
 * moment plus 150 s (S6-6). The bind-and-renew statement is S6-6's and the
 * release is S6-4's.
 */
import type { PoolClient } from 'pg';
import type { DemoStartRequest, StartTransactionSteps, TakenLease } from './start-transaction';

/** The `Calls` request's own bound; an abort is the unconfirmed `timeout` case. */
export const CALLS_REQUEST_TIMEOUT_MS = 10_000;
/** Twilio ring `Timeout`. */
export const RING_TIMEOUT_S = 30;
/** Twilio `TimeLimit`: the longest a demo call can talk. */
export const TIME_LIMIT_S = 90;
/** Slack past the provider's own limits. */
export const GRACE_S = 30;
/** `expires_at` at insert: request bound + ring timeout + grace. */
export const PRE_LIVE_WINDOW_S = 70;
/** `expires_at` after the one renewal: ring timeout + time limit + grace, from the live callback. */
export const LIVE_LEASE_S = 150;

const LIVE_STATUSES: ReadonlySet<string> = new Set(['ringing', 'in-progress']);

/**
 * The `$live` table: true only for a callback whose `CallStatus` proves the
 * call has left Twilio's queue. `queued` and `initiated` do not; a terminal
 * status ends the lease and never extends it; the `Calls` response is not a
 * callback at all.
 */
export function isLiveStatus(callStatus: string | null | undefined): boolean {
  return typeof callStatus === 'string' && LIVE_STATUSES.has(callStatus);
}

export interface InsertedLease {
  id: string;
  tenantId: string;
  generation: number;
  leasedAt: Date;
  expiresAt: Date;
}

/**
 * Pick a free demo tenant of `trade` and lease it, on the caller's open
 * transaction. Null when the trade has no free tenant, or when the insert
 * hits a unique index (a tenant taken by a concurrent caller between the
 * pick and the insert, or this visitor already holding an unreleased lease):
 * the caller answers busy and rolls back, so nothing is spent. `at` is the
 * start transaction's clock, the same one the allowance and the budget day
 * use; `expires_at` is exactly 70 s after it.
 */
export async function insertLease(
  client: PoolClient,
  input: { trade: string; phoneHash: string },
  at: Date,
): Promise<InsertedLease | null> {
  const picked = await client.query<{ id: string }>(
    `SELECT id FROM tenants
      WHERE demo = true AND demo_trade = $1
        AND NOT EXISTS (
          SELECT 1 FROM demo_tenant_leases l
           WHERE l.tenant_id = tenants.id AND l.released_at IS NULL)
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
    [input.trade],
  );
  if (picked.rows.length === 0) return null;
  const tenantId = picked.rows[0].id;

  const { rows } = await client.query<{
    id: string;
    generation: string;
    leased_at: Date;
    expires_at: Date;
  }>(
    `INSERT INTO demo_tenant_leases (tenant_id, visitor_phone_hash, leased_at, expires_at, generation)
     VALUES ($1, $2, $3::timestamptz, $3::timestamptz + make_interval(secs => $4), nextval('demo_lease_generation_seq'))
     ON CONFLICT DO NOTHING
     RETURNING id, generation, leased_at, expires_at`,
    [tenantId, input.phoneHash, at, PRE_LIVE_WINDOW_S],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const generation = Number(r.generation);
  if (!Number.isSafeInteger(generation)) throw new Error(`lease generation out of range: ${r.generation}`);
  return { id: r.id, tenantId, generation, leasedAt: r.leased_at, expiresAt: r.expires_at };
}

/** Step (2) of the start transaction: the real lease. */
export const demoLeaseStep: StartTransactionSteps = {
  async takeLease(client: PoolClient, req: DemoStartRequest, at: Date): Promise<TakenLease | null> {
    const lease = await insertLease(client, { trade: req.trade, phoneHash: req.phoneHash }, at);
    if (!lease) return null;
    return { leaseId: lease.id, tenantId: lease.tenantId, generation: lease.generation };
  },
};
