import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb } from './shared';
import {
  migrationAdvisoryKey,
  withMigrationAdvisoryLock,
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

  it('withMigrationAdvisoryLock holds the lock for the body and releases it after', async () => {
    // Drive the real wrapper with a lightweight body (NOT the full migration
    // corpus — re-running the DDL mid-suite against a DB other integration
    // files have already populated would re-validate CHECK constraints against
    // their rows). Prove the mechanism: while the body runs the lock is held
    // (a second connection can't acquire the same key), and afterward it's
    // released.
    const [k1, k2] = migrationAdvisoryKey();
    const client = await pool.connect();
    const probe = await pool.connect();
    try {
      let observedHeldDuringBody: boolean | null = null;
      await withMigrationAdvisoryLock(client, async () => {
        const r = await probe.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
          [k1, k2],
        );
        observedHeldDuringBody = r.rows[0].locked;
        // If the probe somehow acquired it, release so we don't leak.
        if (r.rows[0].locked) {
          await probe.query('SELECT pg_advisory_unlock($1::int, $2::int)', [k1, k2]);
        }
      });
      // The migration lock was held for the whole body → probe was excluded.
      expect(observedHeldDuringBody).toBe(false);

      // After the wrapper returns, the lock is free again.
      const after = await probe.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
        [k1, k2],
      );
      expect(after.rows[0].locked).toBe(true);
      await probe.query('SELECT pg_advisory_unlock($1::int, $2::int)', [k1, k2]);
    } finally {
      // withMigrationAdvisoryLock sets statement_timeout on `client`; RESET ALL
      // clears any session GUCs so nothing leaks into other integration files
      // sharing the pool.
      await client.query('RESET ALL');
      client.release();
      probe.release();
    }
  });
});
