/**
 * Postgres integration — in-app account deletion (guideline 5.1.1(v)).
 *
 * Pins `PgUserRepository.softDeleteSelf` and the `deleted_at IS NULL` read
 * filters against the REAL migrated schema, so the columns the SQL touches
 * (`deleted_at` from migration 093, the last-owner EXISTS guard) can't drift
 * behind a mocked Pool (CLAUDE.md: "Tests that mock the DB are never the only
 * proof a query works").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgUserRepository } from '../../src/users/pg-user';
import {
  commitRequestTransactionAndBegin,
  tenantContextStore,
} from '../../src/middleware/tenant-context';
import { applyTenantContext } from '../../src/db/rls-runtime-role';

describe('Postgres integration — PgUserRepository.softDeleteSelf', () => {
  let pool: Pool;
  let repo: PgUserRepository;
  let tenantId: string;
  let ownerId: string;

  async function insertUser(role: 'owner' | 'dispatcher' | 'technician'): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, `user_${id}`, `${id}@example.com`, role],
    );
    return id;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgUserRepository(pool);
    const t = await createTestTenant(pool);
    tenantId = t.tenantId;
    ownerId = t.userId;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('blocks the sole owner atomically (last-owner guard)', async () => {
    const blocked = await repo.softDeleteSelf(tenantId, ownerId);
    expect(blocked).toBeNull();
    // Still readable — nothing was stamped.
    expect(await repo.findById(tenantId, ownerId)).not.toBeNull();
  });

  it('soft-deletes a technician and hides them from every read path', async () => {
    const techId = await insertUser('technician');
    await pool.query(
      `UPDATE users SET mobile_number = $1 WHERE id = $2 AND tenant_id = $3`,
      ['+15550001111', techId, tenantId],
    );

    const deleted = await repo.softDeleteSelf(tenantId, techId);
    expect(deleted).not.toBeNull();
    expect(deleted!.id).toBe(techId);

    // Read paths all treat the account as gone.
    expect(await repo.findById(tenantId, techId)).toBeNull();
    expect(await repo.findByMobileNumber(tenantId, '+15550001111')).toBeNull();
    const listed = await repo.findByTenant(tenantId);
    expect(listed.map((u) => u.id)).not.toContain(techId);

    // The row itself is retained (16D: never purge) — but the mobile number
    // is cleared so the users_mobile_unique slot is released.
    const raw = await pool.query(
      `SELECT deleted_at, mobile_number FROM users WHERE id = $1 AND tenant_id = $2`,
      [techId, tenantId],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0].deleted_at).not.toBeNull();
    expect(raw.rows[0].mobile_number).toBeNull();

    // A new teammate can claim the number without hitting the unique index.
    const heirId = await insertUser('technician');
    const heir = await repo.setMobileNumber(tenantId, heirId, '+15550001111');
    expect(heir).not.toBeNull();
    expect(heir!.mobileNumber).toBe('+15550001111');
  });

  it('restoreAccount un-stamps deleted_at and re-instates the mobile number', async () => {
    const techId = await insertUser('technician');
    await pool.query(
      `UPDATE users SET mobile_number = $1 WHERE id = $2 AND tenant_id = $3`,
      ['+15550004444', techId, tenantId],
    );
    expect(await repo.softDeleteSelf(tenantId, techId)).not.toBeNull();
    expect(await repo.findById(tenantId, techId)).toBeNull();

    const restored = await repo.restoreAccount(tenantId, techId, '+15550004444');
    expect(restored).not.toBeNull();
    expect(restored!.mobileNumber).toBe('+15550004444');
    // Fully usable again.
    const found = await repo.findById(tenantId, techId);
    expect(found).not.toBeNull();
    expect(found!.mobileNumber).toBe('+15550004444');
    // Restore is a no-op on a live row.
    expect(await repo.restoreAccount(tenantId, techId, null)).toBeNull();
  });

  it('restoreAccount still restores access when the freed number was reclaimed (23505 path)', async () => {
    const techId = await insertUser('technician');
    await pool.query(
      `UPDATE users SET mobile_number = $1 WHERE id = $2 AND tenant_id = $3`,
      ['+15550006666', techId, tenantId],
    );
    expect(await repo.softDeleteSelf(tenantId, techId)).not.toBeNull();

    // A teammate claims the freed number while the Clerk call is in flight.
    const claimant = await insertUser('technician');
    expect(await repo.setMobileNumber(tenantId, claimant, '+15550006666')).not.toBeNull();

    // The compensating restore must NOT throw and must restore access; the
    // number stays with the claimant.
    const restored = await repo.restoreAccount(tenantId, techId, '+15550006666');
    expect(restored).not.toBeNull();
    expect(restored!.mobileNumber).toBeUndefined();
    expect(await repo.findById(tenantId, techId)).not.toBeNull();
    const claimantRow = await repo.findById(tenantId, claimant);
    expect(claimantRow!.mobileNumber).toBe('+15550006666');
  });

  it('is idempotent — a second delete of the same row returns null', async () => {
    const techId = await insertUser('technician');
    expect(await repo.softDeleteSelf(tenantId, techId)).not.toBeNull();
    expect(await repo.softDeleteSelf(tenantId, techId)).toBeNull();
  });

  it('lets an owner delete when another live owner exists, then re-blocks the survivor', async () => {
    const owner2 = await insertUser('owner');

    // Two live owners → owner2 may leave.
    const deleted = await repo.softDeleteSelf(tenantId, owner2);
    expect(deleted).not.toBeNull();

    // owner2 is deleted, so the original owner is sole owner again — the
    // EXISTS guard must NOT count soft-deleted owners.
    const blocked = await repo.softDeleteSelf(tenantId, ownerId);
    expect(blocked).toBeNull();
  });

  it('serializes on the tenant row: softDeleteSelf blocks while another txn holds the lock', async () => {
    // Pins the FOR UPDATE serialization anchor that makes the last-owner
    // guard sound under the request-scoped /api transaction: a concurrent
    // deletion in the same tenant must WAIT for the first one's COMMIT.
    const techId = await insertUser('technician');
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);

      let settled = false;
      const pending = repo.softDeleteSelf(tenantId, techId).then((r) => {
        settled = true;
        return r;
      });
      // Give the blocked query ample time to have completed if it were NOT
      // waiting on the tenant lock.
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);

      await locker.query('COMMIT');
      const result = await pending;
      expect(settled).toBe(true);
      expect(result).not.toBeNull();
    } finally {
      locker.release();
    }
  });

  it('demoteOwnerIfAnotherExists takes the same tenant lock (serializes with deletions)', async () => {
    const owner2 = await insertUser('owner');
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);

      let settled = false;
      const pending = repo
        .demoteOwnerIfAnotherExists(tenantId, owner2, 'technician')
        .then((r) => {
          settled = true;
          return r;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);

      await locker.query('COMMIT');
      const result = await pending;
      expect(result).not.toBeNull();
      expect(result!.role).toBe('technician');
    } finally {
      locker.release();
    }
  });

  it('rejects writes to a soft-deleted row (phone + profile updates)', async () => {
    const techId = await insertUser('technician');
    expect(await repo.softDeleteSelf(tenantId, techId)).not.toBeNull();

    // An explicit-UUID write racing the deletion must not repopulate the
    // hidden row (it would re-block the users_mobile_unique slot).
    expect(await repo.setMobileNumber(tenantId, techId, '+15550005555')).toBeNull();
    expect(await repo.update(tenantId, techId, { firstName: 'Ghost' })).toBeNull();

    const raw = await pool.query(
      `SELECT mobile_number, first_name FROM users WHERE id = $1 AND tenant_id = $2`,
      [techId, tenantId],
    );
    expect(raw.rows[0].mobile_number).toBeNull();
    expect(raw.rows[0].first_name).toBeNull();
  });

  it('commitRequestTransactionAndBegin makes the stamp durable mid-request', async () => {
    // Simulates the /api request-scoped transaction: the stamp must become
    // visible to OTHER connections after the early commit (durable before
    // the Clerk call), while the request client keeps a usable transaction
    // for the compensation path.
    const techId = await insertUser('technician');
    const reqClient = await pool.connect();
    try {
      await reqClient.query('BEGIN');
      await applyTenantContext(reqClient, tenantId, { transactional: true });

      await tenantContextStore.run({ client: reqClient, tenantId }, async () => {
        const stamped = await repo.softDeleteSelf(tenantId, techId);
        expect(stamped).not.toBeNull();
        await commitRequestTransactionAndBegin();
      });

      // Independent connection (outside the request context): the deletion
      // is already durable even though the "request" hasn't finished.
      expect(await repo.findById(tenantId, techId)).toBeNull();

      // The request client is in a fresh, usable transaction — the
      // compensation path can still write through it.
      await tenantContextStore.run({ client: reqClient, tenantId }, async () => {
        const restored = await repo.restoreAccount(tenantId, techId, null);
        expect(restored).not.toBeNull();
      });
      await reqClient.query('COMMIT');
      expect(await repo.findById(tenantId, techId)).not.toBeNull();
    } finally {
      reqClient.release();
    }
  });

  it('never crosses tenants', async () => {
    const other = await createTestTenant(pool);
    const techId = await insertUser('technician');
    // Deleting with the WRONG tenant id must be a no-op.
    expect(await repo.softDeleteSelf(other.tenantId, techId)).toBeNull();
    expect(await repo.findById(tenantId, techId)).not.toBeNull();
  });
});
