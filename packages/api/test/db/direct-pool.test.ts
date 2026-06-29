import { describe, it, expect, afterEach } from 'vitest';
import { createDirectPool } from '../../src/db/pool';

/**
 * U2a — the direct (session-mode) pool used for Postgres state that is unsafe
 * under PgBouncer transaction pooling (session advisory locks, LISTEN/NOTIFY).
 * These pin the env-driven selection so the fallback-to-main-pool behavior
 * (when DATABASE_DIRECT_URL is unset) can't silently regress.
 */
describe('createDirectPool', () => {
  const savedUrl = process.env.DATABASE_DIRECT_URL;
  const savedMax = process.env.DB_DIRECT_MAX_CONNECTIONS;

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.DATABASE_DIRECT_URL;
    else process.env.DATABASE_DIRECT_URL = savedUrl;
    if (savedMax === undefined) delete process.env.DB_DIRECT_MAX_CONNECTIONS;
    else process.env.DB_DIRECT_MAX_CONNECTIONS = savedMax;
  });

  it('returns null when DATABASE_DIRECT_URL is unset (caller reuses the main pool)', () => {
    delete process.env.DATABASE_DIRECT_URL;
    expect(createDirectPool()).toBeNull();
  });

  it('builds a pool against DATABASE_DIRECT_URL when set', async () => {
    process.env.DATABASE_DIRECT_URL = 'postgres://u:p@direct-host:5432/db';
    process.env.DB_DIRECT_MAX_CONNECTIONS = '7';
    const pool = createDirectPool();
    expect(pool).not.toBeNull();
    expect(pool!.options.connectionString).toBe('postgres://u:p@direct-host:5432/db');
    expect(pool!.options.max).toBe(7);
    await pool!.end(); // never connected — end() just tears down the (empty) pool
  });

  it('defaults max to 10 when DB_DIRECT_MAX_CONNECTIONS is unset', async () => {
    process.env.DATABASE_DIRECT_URL = 'postgres://u:p@direct-host:5432/db';
    delete process.env.DB_DIRECT_MAX_CONNECTIONS;
    const pool = createDirectPool();
    expect(pool!.options.max).toBe(10);
    await pool!.end();
  });
});
