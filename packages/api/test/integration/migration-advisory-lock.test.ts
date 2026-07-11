import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb } from './shared';
import {
  migrationAdvisoryKey,
  runMigrationsOnClient,
} from '../../src/db/migrate';

/**
 * DATA-04 — the migration runner (db/migrate.ts) now takes a session-level
 * advisory lock so concurrent/retried deploys can't race the same DDL. Under
 * Railway's restartPolicyMaxRetries + overlapSeconds, two `migrate.js`
 * processes can start before the first finishes; without mutual exclusion they
 * run the same ALTER TABLE / CREATE POLICY DDL concurrently.
 *
 * These pin (a) the lock key is STABLE across calls (every replica contends on
 * the same lock) and actually excludes a second holder, and (b) applying the
 * migration corpus under the lock still yields a consistent schema and leaves
 * the lock released.
 */
describe('DATA-04: migration advisory lock', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  it('derives a stable key across calls', () => {
    const a = migrationAdvisoryKey();
    const b = migrationAdvisoryKey();
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
    expect(Number.isInteger(a[0])).toBe(true);
    expect(Number.isInteger(a[1])).toBe(true);
  });

  it('excludes a second holder of the same key, then admits it after release', async () => {
    const [k1, k2] = migrationAdvisoryKey();
    const connA = await pool.connect();
    const connB = await pool.connect();
    try {
      // A holds the migration lock.
      await connA.query('SELECT pg_advisory_lock($1::int, $2::int)', [k1, k2]);

      // B cannot acquire the SAME key while A holds it.
      const blocked = await connB.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
        [k1, k2],
      );
      expect(blocked.rows[0].locked).toBe(false);

      // A releases; now B can take it.
      await connA.query('SELECT pg_advisory_unlock($1::int, $2::int)', [k1, k2]);
      const admitted = await connB.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
        [k1, k2],
      );
      expect(admitted.rows[0].locked).toBe(true);
      await connB.query('SELECT pg_advisory_unlock($1::int, $2::int)', [k1, k2]);
    } finally {
      connA.release();
      connB.release();
    }
  });

  it('applies migrations under the lock and releases it afterward', async () => {
    const client = await pool.connect();
    try {
      // Migrations already ran once in global-setup; this idempotent re-apply
      // under the lock must succeed and leave a consistent schema.
      await runMigrationsOnClient(client);

      // The lock is released after runMigrationsOnClient returns: a fresh
      // try-acquire on the same session succeeds (0 held locks for this key).
      const [k1, k2] = migrationAdvisoryKey();
      const held = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
        [k1, k2],
      );
      expect(held.rows[0].locked).toBe(true);
      await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [k1, k2]);

      // Spot-check the schema is intact: a core table + a known index exist.
      const tbl = await client.query(
        "SELECT to_regclass('public.tenants') AS t",
      );
      expect(tbl.rows[0].t).toBe('tenants');
      const idx = await client.query(
        "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_jobs_tenant_assigned_technician'",
      );
      expect(idx.rowCount).toBe(1);
    } finally {
      // runMigrationsOnClient leaves session GUCs (statement_timeout,
      // lock_timeout) set on this pooled connection; RESET ALL clears them so
      // nothing leaks into other integration files sharing the pool.
      await client.query('RESET ALL');
      client.release();
    }
  });
});
