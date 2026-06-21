/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Pins the reconciled `tenant_integrations` column contract against the REAL
 * migrated schema. Two migration keys both `CREATE TABLE IF NOT EXISTS
 * tenant_integrations`; the earlier one (070_tenant_location_and_integrations)
 * wins and historically left the table with the WRONG auth-token columns:
 *   - missing auth_token_primary_enc / auth_token_secondary_enc (what every
 *     credential path uses) — added back by migration 206,
 *   - carrying dead auth_token_primary_secret_ref / _secondary_secret_ref
 *     (no code ever read/wrote them) — dropped by migration 207.
 *
 * A mocked Pool can't catch this (the entity-resolver "nonexistent columns"
 * lesson in CLAUDE.md): only an introspection against a freshly-migrated DB
 * proves migrations 206+207 converged the schema correctly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeSharedTestDb, getSharedTestDb } from './shared';

async function columnNames(pool: Pool, table: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

describe('Postgres integration — tenant_integrations schema contract', () => {
  let pool: Pool;
  let columns: Set<string>;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    columns = await columnNames(pool, 'tenant_integrations');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('has the AES-encrypted auth-token columns the credential path uses (migration 206)', () => {
    expect(columns.has('auth_token_primary_enc')).toBe(true);
    expect(columns.has('auth_token_secondary_enc')).toBe(true);
  });

  it('no longer carries the dead secret_ref columns (migration 207)', () => {
    expect(columns.has('auth_token_primary_secret_ref')).toBe(false);
    expect(columns.has('auth_token_secondary_secret_ref')).toBe(false);
  });

  it('retains the shared columns every provider row needs', () => {
    for (const c of ['tenant_id', 'provider', 'status', 'subaccount_sid', 'credential_version', 'provider_data', 'credentials']) {
      expect(columns.has(c), `expected tenant_integrations.${c}`).toBe(true);
    }
  });
});
