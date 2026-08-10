/**
 * Postgres integration — material items (PgMaterialItemRepository).
 *
 * Tradesperson wave 1, Task 8: material_items (migration 272) is a brand new
 * TABLE. This pins the real SQL — create -> listPending -> markPurchased —
 * AND proves RLS actually isolates tenants at the DB level (not just via the
 * repo's own `WHERE tenant_id = $1`, which would pass even with a broken or
 * absent policy). The DB-level check runs through the unprivileged
 * `rls_app_runtime` role, mirroring rls-tenant-isolation.test.ts, since the
 * testcontainer's default connection is a superuser and superusers bypass
 * RLS unconditionally.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import {
  getSharedTestDb,
  createTestTenant,
  closeSharedTestDb,
  RLS_APP_ROLE,
  TestTenant,
} from './shared';
import { PgMaterialItemRepository } from '../../src/materials/pg-material-item';
import { ValidationError } from '../../src/shared/errors';

/**
 * Insert the customer -> location -> job FK chain under tenant RLS context.
 * Mirrors the identically-named helper in feedback.test.ts.
 */
async function createJob(pool: Pool, tenant: TestTenant): Promise<string> {
  const customerId = randomUUID();
  const locationId = randomUUID();
  const jobId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
    await client.query(
      `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
      [customerId, tenant.tenantId, 'Test Customer', tenant.userId],
    );
    await client.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [locationId, tenant.tenantId, customerId, '1 Main St', 'Austin', 'TX', '78701'],
    );
    await client.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, tenant.tenantId, customerId, locationId, `JOB-${jobId.slice(0, 8)}`, 'Test job', tenant.userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return jobId;
}

/**
 * Run `fn` on a connection that behaves like the production app: an
 * unprivileged role with `app.current_tenant_id` set for the duration of a
 * transaction. Always rolls back so the test is side-effect free. Mirrors
 * `asTenant` in rls-tenant-isolation.test.ts.
 */
async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${RLS_APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Postgres integration — material items', () => {
  let pool: Pool;
  let repo: PgMaterialItemRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgMaterialItemRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('round-trips create -> listPending -> markPurchased', async () => {
    const created = await repo.create({
      tenantId: tenant.tenantId,
      description: '3 boxes 1/2" PEX',
      quantity: 3,
      createdBy: tenant.userId,
    });
    expect(created.status).toBe('pending');
    expect(created.quantity).toBe(3);
    expect(typeof created.quantity).toBe('number');

    const pending = await repo.listPending(tenant.tenantId);
    expect(pending.map((i) => i.id)).toContain(created.id);

    const purchased = await repo.markPurchased(tenant.tenantId, created.id, tenant.userId);
    expect(purchased).not.toBeNull();
    expect(purchased!.status).toBe('purchased');
    expect(purchased!.purchasedBy).toBe(tenant.userId);
    expect(purchased!.purchasedAt).toBeInstanceOf(Date);

    const stillPending = await repo.listPending(tenant.tenantId);
    expect(stillPending.map((i) => i.id)).not.toContain(created.id);
  });

  it('scopes listPending by jobId when given', async () => {
    const jobId = await createJob(pool, tenant);
    await repo.create({
      tenantId: tenant.tenantId,
      description: 'job-scoped item',
      jobId,
      createdBy: tenant.userId,
    });
    await repo.create({
      tenantId: tenant.tenantId,
      description: 'unscoped item',
      createdBy: tenant.userId,
    });

    const scoped = await repo.listPending(tenant.tenantId, { jobId });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].description).toBe('job-scoped item');
  });

  // Follow-up to Task 9 — real SQL proof that `needed_by < $N` behaves the
  // way the in-memory backend's unit tests assert, including the NULL
  // exclusion the Pg side gets "for free" from three-valued logic (never
  // an app-side special case, unlike InMemory which must filter it
  // explicitly — see MaterialItemListOptions.neededByBefore's doc comment).
  describe('neededByBefore filter (real SQL)', () => {
    it('returns only rows with needed_by strictly before the boundary', async () => {
      const t = await createTestTenant(pool);
      const dueBefore = await repo.create({
        tenantId: t.tenantId,
        description: 'due before',
        neededBy: new Date('2026-08-09T00:00:00Z'),
        createdBy: t.userId,
      });
      await repo.create({
        tenantId: t.tenantId,
        description: 'due at boundary (excluded, exclusive)',
        neededBy: new Date('2026-08-10T00:00:00Z'),
        createdBy: t.userId,
      });

      const result = await repo.listPending(t.tenantId, {
        neededByBefore: new Date('2026-08-10T00:00:00Z'),
      });
      expect(result.map((i) => i.id)).toEqual([dueBefore.id]);
    });

    it('excludes rows with a NULL needed_by — three-valued logic, no special-case needed', async () => {
      const t = await createTestTenant(pool);
      const dated = await repo.create({
        tenantId: t.tenantId,
        description: 'dated',
        neededBy: new Date('2026-08-01T00:00:00Z'),
        createdBy: t.userId,
      });
      await repo.create({ tenantId: t.tenantId, description: 'undated', createdBy: t.userId });

      const result = await repo.listPending(t.tenantId, {
        neededByBefore: new Date('2026-09-01T00:00:00Z'),
      });
      expect(result.map((i) => i.id)).toEqual([dated.id]);
    });

    it('orders date-scoped results by needed_by ascending, not created_at', async () => {
      const t = await createTestTenant(pool);
      const createdFirstDueLater = await repo.create({
        tenantId: t.tenantId,
        description: 'created first, due later',
        neededBy: new Date('2026-08-09T00:00:00Z'),
        createdBy: t.userId,
      });
      const createdSecondDueSooner = await repo.create({
        tenantId: t.tenantId,
        description: 'created second, due sooner',
        neededBy: new Date('2026-08-01T00:00:00Z'),
        createdBy: t.userId,
      });

      const result = await repo.listPending(t.tenantId, {
        neededByBefore: new Date('2026-08-10T00:00:00Z'),
      });
      expect(result.map((i) => i.id)).toEqual([
        createdSecondDueSooner.id,
        createdFirstDueLater.id,
      ]);
    });

    // Review follow-up J1 (2026-08-09) — real-SQL proof of the tie-break
    // that made the two backends diverge. `add-material-handler.ts` writes
    // every voice-captured needed_by at exact UTC midnight, so two items due
    // the same day tie EXACTLY on the sort key. Before `created_at ASC` was
    // added, this ORDER BY fell straight through to `id ASC` — a random v4
    // UUID — while InMemory's stable sort gave insertion order, so under
    // lookup_materials's 5-item cap the two backends spoke DIFFERENT
    // SUBSETS. Both rows here get their created_at from the DB clock (NOW(),
    // one transaction per create()), so the expected order is insertion
    // order, deterministically, on every run.
    it('breaks an exact needed_by tie on created_at (insertion order), not the random uuid', async () => {
      const t = await createTestTenant(pool);
      const sameDay = new Date('2026-06-12T00:00:00Z');
      const first = await repo.create({
        tenantId: t.tenantId,
        description: 'first captured',
        neededBy: sameDay,
        createdBy: t.userId,
      });
      const second = await repo.create({
        tenantId: t.tenantId,
        description: 'second captured',
        neededBy: sameDay,
        createdBy: t.userId,
      });
      const third = await repo.create({
        tenantId: t.tenantId,
        description: 'third captured',
        neededBy: sameDay,
        createdBy: t.userId,
      });

      const result = await repo.listPending(t.tenantId, {
        neededByFrom: sameDay,
        neededByBefore: new Date('2026-06-13T00:00:00Z'),
      });
      expect(result.map((i) => i.id)).toEqual([first.id, second.id, third.id]);
    });
  });

  // Review follow-up K3 — real-SQL proof of the INCLUSIVE lower bound that
  // lets lookup_materials isolate "due ON the asked-for day" from an overdue
  // backlog that would otherwise consume its whole spoken cap.
  describe('neededByFrom lower bound (real SQL)', () => {
    it('brackets a single day: includes needed_by = from, excludes anything earlier or later', async () => {
      const t = await createTestTenant(pool);
      await repo.create({
        tenantId: t.tenantId,
        description: 'months overdue',
        neededBy: new Date('2026-03-02T00:00:00Z'),
        createdBy: t.userId,
      });
      const onDay = await repo.create({
        tenantId: t.tenantId,
        description: 'due on the asked-for day',
        neededBy: new Date('2026-06-12T00:00:00Z'),
        createdBy: t.userId,
      });
      await repo.create({
        tenantId: t.tenantId,
        description: 'due next week',
        neededBy: new Date('2026-06-19T00:00:00Z'),
        createdBy: t.userId,
      });
      await repo.create({ tenantId: t.tenantId, description: 'undated', createdBy: t.userId });

      const result = await repo.listPending(t.tenantId, {
        neededByFrom: new Date('2026-06-12T00:00:00Z'),
        neededByBefore: new Date('2026-06-13T00:00:00Z'),
      });
      expect(result.map((i) => i.id)).toEqual([onDay.id]);
    });

    // J2 — a malformed bound narrows to nothing, never widens. Pg used to
    // drop the predicate entirely and answer a date-scoped question with the
    // tenant's whole pending list.
    it('returns [] for a malformed date bound instead of the whole pending list', async () => {
      const t = await createTestTenant(pool);
      await repo.create({
        tenantId: t.tenantId,
        description: 'pending',
        neededBy: new Date('2026-06-12T00:00:00Z'),
        createdBy: t.userId,
      });

      expect(
        await repo.listPending(t.tenantId, {
          neededByBefore: '2026-06-13T00:00:00.000Z' as unknown as Date,
        }),
      ).toEqual([]);
      expect(
        await repo.listPending(t.tenantId, { neededByFrom: new Date('nonsense') }),
      ).toEqual([]);
    });
  });

  // Quality-review I4 — the SQL LIMIT clause, not an app-side slice.
  it('scopes listPending by limit, applied in SQL', async () => {
    const t = await createTestTenant(pool);
    const first = await repo.create({ tenantId: t.tenantId, description: 'a', createdBy: t.userId });
    await repo.create({ tenantId: t.tenantId, description: 'b', createdBy: t.userId });
    await repo.create({ tenantId: t.tenantId, description: 'c', createdBy: t.userId });

    const limited = await repo.listPending(t.tenantId, { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe(first.id);
  });

  it('does not mark another tenant\'s item purchased (repo-level tenant check, cross-tenant-null)', async () => {
    const created = await repo.create({
      tenantId: tenant.tenantId,
      description: 'cross-tenant guard',
      createdBy: tenant.userId,
    });
    const result = await repo.markPurchased(other.tenantId, created.id, other.userId);
    expect(result).toBeNull();
  });

  it('returns null on a second markPurchased call against the same row (double-purchase)', async () => {
    const t = await createTestTenant(pool);
    const created = await repo.create({ tenantId: t.tenantId, description: 'PEX', createdBy: t.userId });
    const first = await repo.markPurchased(t.tenantId, created.id, t.userId);
    expect(first).not.toBeNull();
    const second = await repo.markPurchased(t.tenantId, created.id, t.userId);
    expect(second).toBeNull();
  });

  it(
    'returns pending items in a stable order across repeated calls (determinism, ' +
      'not insertion-order fidelity — see the created_at,id tiebreak in pg-material-item.ts)',
    async () => {
      const t = await createTestTenant(pool);
      await repo.create({ tenantId: t.tenantId, description: 'a', createdBy: t.userId });
      await repo.create({ tenantId: t.tenantId, description: 'b', createdBy: t.userId });
      await repo.create({ tenantId: t.tenantId, description: 'c', createdBy: t.userId });

      const first = await repo.listPending(t.tenantId);
      const second = await repo.listPending(t.tenantId);
      expect(first).toHaveLength(3);
      expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    },
  );

  describe('graceful handling of malformed ids (Task 9: an LLM-invented id must not 500)', () => {
    it('listPending returns [] for a non-UUID-shaped tenantId instead of throwing', async () => {
      expect(await repo.listPending('not-a-uuid')).toEqual([]);
    });

    it('listPending returns [] for a well-formed but unknown tenantId', async () => {
      expect(await repo.listPending(randomUUID())).toEqual([]);
    });

    it('markPurchased returns null for a non-UUID-shaped item id instead of throwing', async () => {
      expect(await repo.markPurchased(tenant.tenantId, 'not-a-uuid', tenant.userId)).toBeNull();
    });

    it('markPurchased returns null for a non-UUID-shaped tenantId instead of throwing', async () => {
      const created = await repo.create({
        tenantId: tenant.tenantId,
        description: 'malformed tenant guard',
        createdBy: tenant.userId,
      });
      expect(await repo.markPurchased('not-a-uuid', created.id, tenant.userId)).toBeNull();
    });

    it(
      'listPending returns [] for a non-UUID-shaped jobId instead of throwing or ' +
        "falling back to the tenant's whole pending list",
      async () => {
        // Task 9's lookup_materials can pass a jobId from an unresolved
        // spoken job reference ("the Patel job" that didn't resolve). This
        // must behave like the malformed-tenantId case above — [], not a
        // raw "invalid input syntax for type uuid" from job_id = $N below,
        // and NOT the tenant's full list (that would look like a caller
        // asking for one job's items and silently getting everyone's).
        await repo.create({
          tenantId: tenant.tenantId,
          description: 'unfiltered by the malformed jobId below',
          createdBy: tenant.userId,
        });
        expect(await repo.listPending(tenant.tenantId, { jobId: 'not-a-uuid' })).toEqual([]);
      },
    );

    it('markPurchased rejects an empty actorId', async () => {
      const created = await repo.create({
        tenantId: tenant.tenantId,
        description: 'actor guard',
        createdBy: tenant.userId,
      });
      await expect(repo.markPurchased(tenant.tenantId, created.id, '')).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe('RLS enforcement (DB-level, unprivileged role)', () => {
    it('a tenant reading material_items directly sees only its own rows', async () => {
      const mine = await repo.create({
        tenantId: tenant.tenantId,
        description: 'mine',
        createdBy: tenant.userId,
      });
      const theirs = await repo.create({
        tenantId: other.tenantId,
        description: 'theirs',
        createdBy: other.userId,
      });

      const idsVisibleToTenant = await asTenant(pool, tenant.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>('SELECT id FROM material_items');
        return rows.map((r) => r.id);
      });
      expect(idsVisibleToTenant).toContain(mine.id);
      expect(idsVisibleToTenant).not.toContain(theirs.id);

      const idsVisibleToOther = await asTenant(pool, other.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>('SELECT id FROM material_items');
        return rows.map((r) => r.id);
      });
      expect(idsVisibleToOther).toContain(theirs.id);
      expect(idsVisibleToOther).not.toContain(mine.id);
    });

    it('an unknown tenant context cannot enumerate any material_items rows', async () => {
      await repo.create({
        tenantId: tenant.tenantId,
        description: 'should stay hidden',
        createdBy: tenant.userId,
      });
      const strangerTenant = randomUUID();
      const count = await asTenant(pool, strangerTenant, async (client) => {
        const { rows } = await client.query('SELECT id FROM material_items');
        return rows.length;
      });
      expect(count).toBe(0);
    });

    it('cannot INSERT a material_items row attributed to another tenant (WITH CHECK)', async () => {
      // material_items' policy is USING-only (no explicit WITH CHECK) —
      // Postgres reuses the USING expression for WITH CHECK when one isn't
      // given, so this must reject exactly like the customers table does
      // (rls-tenant-isolation.test.ts). Proven locally rather than inherited
      // from that sibling test, since a per-table policy typo wouldn't be
      // caught by another table's assertion.
      await expect(
        asTenant(pool, tenant.tenantId, async (client) => {
          await client.query(
            `INSERT INTO material_items (id, tenant_id, description, created_by)
             VALUES ($1, $2, $3, $4)`,
            [randomUUID(), other.tenantId, 'Forged', tenant.userId],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it('an unprivileged role scoped to tenant A cannot UPDATE tenant B\'s row', async () => {
      const theirs = await repo.create({
        tenantId: other.tenantId,
        description: 'not yours to purchase',
        createdBy: other.userId,
      });

      const updatedCount = await asTenant(pool, tenant.tenantId, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE material_items SET status = 'purchased' WHERE id = $1`,
          [theirs.id],
        );
        return rowCount;
      });
      expect(updatedCount).toBe(0);

      // Untouched — still pending under its real tenant.
      const stillPending = await repo.listPending(other.tenantId);
      expect(stillPending.map((i) => i.id)).toContain(theirs.id);
    });
  });
});
