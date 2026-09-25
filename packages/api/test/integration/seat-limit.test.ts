/**
 * Plans include 2 (Starter) or 5 (Growth) users. Every login counts,
 * technicians included, and so does every unexpired pending invitation —
 * otherwise a shop could park open invites past the limit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { inviteTeamMember } from '../../src/users/invite-team-member';
import { PgPendingInvitationRepository } from '../../src/users/pg-pending-invitation';
import { PgSeatUsageReader } from '../../src/users/seat-limit';

describe('Postgres integration — per-plan user limit at invite time', () => {
  let pool: Pool;
  let invitations: PgPendingInvitationRepository;
  let seats: PgSeatUsageReader;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invitations = new PgPendingInvitationRepository(pool);
    seats = new PgSeatUsageReader(pool);
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** A tenant with its owner plus `extraUsers` more logins of the given role. */
  async function tenantWith(planId: 'starter' | 'growth' | null, extraUsers: number, role = 'technician') {
    const { tenantId, userId } = await createTestTenant(pool);
    await pool.query('UPDATE tenants SET plan_id = $2 WHERE id = $1', [tenantId, planId]);
    for (let i = 0; i < extraUsers; i += 1) {
      await pool.query(
        `INSERT INTO users (tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4)`,
        [tenantId, `clerk_${randomUUID()}`, `u${i}-${randomUUID().slice(0, 6)}@shop.test`, role],
      );
    }
    return { tenantId, ownerId: userId };
  }

  function invite(tenantId: string, ownerId: string) {
    return inviteTeamMember(
      { tenantId, email: `new-${randomUUID().slice(0, 8)}@shop.test`, role: 'technician', invitedBy: ownerId },
      invitations,
      {},
      seats,
    );
  }

  it('lets a Starter owner invite a second user, then refuses a third', async () => {
    const { tenantId, ownerId } = await tenantWith('starter', 0);

    await expect(invite(tenantId, ownerId)).resolves.toBeDefined();
    await expect(invite(tenantId, ownerId)).rejects.toMatchObject({
      code: 'SEAT_LIMIT_REACHED',
      message: expect.stringMatching(/Starter includes 2 users.*Growth/),
    });
  });

  it('counts technicians as users', async () => {
    const { tenantId, ownerId } = await tenantWith('starter', 1, 'technician');

    await expect(invite(tenantId, ownerId)).rejects.toMatchObject({ code: 'SEAT_LIMIT_REACHED' });
  });

  it('ignores deleted users and expired invitations', async () => {
    const { tenantId, ownerId } = await tenantWith('starter', 1);
    await pool.query(
      `UPDATE users SET deleted_at = NOW() WHERE tenant_id = $1 AND role = 'technician'`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO pending_invitations (tenant_id, email, role, invited_by, expires_at)
       VALUES ($1, 'stale@shop.test', 'technician', $2, NOW() - INTERVAL '1 day')`,
      [tenantId, ownerId],
    );

    await expect(invite(tenantId, ownerId)).resolves.toBeDefined();
  });

  it('lets Growth reach 5 users and refuses a sixth', async () => {
    const { tenantId, ownerId } = await tenantWith('growth', 3);

    await expect(invite(tenantId, ownerId)).resolves.toBeDefined();
    await expect(invite(tenantId, ownerId)).rejects.toMatchObject({
      code: 'SEAT_LIMIT_REACHED',
      message: expect.stringMatching(/Growth includes 5 users/),
    });
  });

  it('applies the Starter limit before a plan is recorded', async () => {
    const { tenantId, ownerId } = await tenantWith(null, 1);

    await expect(invite(tenantId, ownerId)).rejects.toMatchObject({ code: 'SEAT_LIMIT_REACHED' });
  });
});
