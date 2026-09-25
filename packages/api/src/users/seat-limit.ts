/**
 * Per-plan user limit. Starter includes 2 users and Growth 5; every login
 * counts (technicians included) plus every unexpired pending invitation, so
 * open invites cannot be parked past the limit. A tenant with no recorded
 * plan yet (before checkout) gets the Starter limit.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { AppError } from '../shared/errors';
import { CALL_PLAN_USAGE, type CallPlanId } from '../billing/call-usage-pricing';

export interface SeatUsage {
  planId: CallPlanId | null;
  /** Non-deleted users plus unexpired, unaccepted invitations. */
  seatsUsed: number;
}

export interface SeatUsageReader {
  getSeatUsage(tenantId: string): Promise<SeatUsage>;
}

export class PgSeatUsageReader extends PgBaseRepository implements SeatUsageReader {
  constructor(pool: Pool) {
    super(pool);
  }

  async getSeatUsage(tenantId: string): Promise<SeatUsage> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ plan_id: CallPlanId | null; seats_used: string }>(
        `SELECT t.plan_id,
                ((SELECT COUNT(*) FROM users u
                   WHERE u.tenant_id = t.id AND u.deleted_at IS NULL)
               + (SELECT COUNT(*) FROM pending_invitations p
                   WHERE p.tenant_id = t.id AND p.accepted_at IS NULL
                     AND p.expires_at > NOW()))::text AS seats_used
           FROM tenants t WHERE t.id = $1`,
        [tenantId],
      );
      const row = result.rows[0];
      return { planId: row?.plan_id ?? null, seatsUsed: Number(row?.seats_used ?? 0) };
    });
  }
}

/** Throws SEAT_LIMIT_REACHED when one more user would exceed the plan. */
export function assertSeatAvailable(usage: SeatUsage): void {
  const planId = usage.planId ?? 'starter';
  const { includedUsers } = CALL_PLAN_USAGE[planId];
  if (usage.seatsUsed < includedUsers) return;
  const message =
    planId === 'starter'
      ? `Starter includes 2 users. Upgrade to Growth for up to 5 users.`
      : `Growth includes 5 users. Contact us to add more.`;
  throw new AppError('SEAT_LIMIT_REACHED', message, 403, {
    planId,
    includedUsers,
    seatsUsed: usage.seatsUsed,
  });
}
