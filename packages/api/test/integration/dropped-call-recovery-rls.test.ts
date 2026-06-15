/**
 * RV-116 fix — the dropped-call recovery sweep must drain due rows across ALL
 * tenants, but `dropped_call_recoveries` is FORCE ROW LEVEL SECURITY. Under a
 * non-bypassing runtime role (how a correct production app connects) a plain
 * cross-tenant SELECT can only ever see the tenant in context — so the system
 * sweep, which has NO tenant in context, would drain nothing.
 *
 * These tests prove the fix: a non-bypassing role only sees its own tenant via
 * a direct SELECT, while the SECURITY DEFINER `find_due_dropped_call_recoveries`
 * function (migration 177) drains due rows across every tenant for the sweep.
 *
 * Like rls-tenant-isolation.test.ts, assertions run through `rls_app_runtime`
 * (NOBYPASSRLS); fixtures are inserted as the superuser pool (RLS-exempt).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';

const APP_ROLE = 'rls_app_runtime';

async function asTenantRuntime<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

// Models the recovery sweep: an unprivileged role with NO tenant in context.
async function asSystemRuntime<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function insertRecovery(
  pool: Pool,
  tenantId: string,
  opts: { scheduledFor: Date; sentAt?: Date | null; suppressed?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO dropped_call_recoveries
       (id, tenant_id, voice_session_id, caller_e164, scheduled_for, sent_at, suppressed_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      tenantId,
      crypto.randomUUID(),
      '+15125550000',
      opts.scheduledFor,
      opts.sentAt ?? null,
      opts.suppressed ?? null,
    ],
  );
  return id;
}

describe('dropped-call recovery sweep — RLS-safe cross-tenant drain (RV-116)', () => {
  let pool: Pool;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };

  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 3_600_000);

  let dueA: string;
  let dueB: string;
  let futureA: string;
  let sentA: string;
  let suppressedA: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();

    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    dueA = await insertRecovery(pool, tenantA.tenantId, { scheduledFor: past });
    dueB = await insertRecovery(pool, tenantB.tenantId, { scheduledFor: past });
    futureA = await insertRecovery(pool, tenantA.tenantId, { scheduledFor: future });
    sentA = await insertRecovery(pool, tenantA.tenantId, { scheduledFor: past, sentAt: new Date() });
    suppressedA = await insertRecovery(pool, tenantA.tenantId, {
      scheduledFor: past,
      suppressed: 'dnc',
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a non-bypassing role only sees its OWN tenant via a direct SELECT (so a sweep would miss other tenants)', async () => {
    const ids = await asTenantRuntime(pool, tenantA.tenantId, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM dropped_call_recoveries
          WHERE sent_at IS NULL AND suppressed_reason IS NULL AND scheduled_for <= now()`,
      );
      return r.rows.map((row) => row.id);
    });
    expect(ids).toContain(dueA);
    expect(ids).not.toContain(dueB); // tenant B's row is invisible — RLS isolates
  });

  it('find_due_dropped_call_recoveries drains due rows across tenants for the system sweep', async () => {
    const rows = await asSystemRuntime(pool, async (c) => {
      const r = await c.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM find_due_dropped_call_recoveries(now(), 100)`,
      );
      return r.rows;
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(dueA);
    expect(ids).toContain(dueB); // BOTH tenants drained — the whole point

    const tenants = new Set(rows.map((r) => r.tenant_id));
    expect(tenants.has(tenantA.tenantId)).toBe(true);
    expect(tenants.has(tenantB.tenantId)).toBe(true);
  });

  it('excludes future, already-sent, and suppressed rows', async () => {
    const ids = await asSystemRuntime(pool, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM find_due_dropped_call_recoveries(now(), 100)`,
      );
      return r.rows.map((row) => row.id);
    });
    expect(ids).not.toContain(futureA);
    expect(ids).not.toContain(sentA);
    expect(ids).not.toContain(suppressedA);
  });

  it('respects the row limit', async () => {
    const count = await asSystemRuntime(pool, async (c) => {
      const r = await c.query(`SELECT id FROM find_due_dropped_call_recoveries(now(), 1)`);
      return r.rows.length;
    });
    expect(count).toBe(1);
  });
});
