import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

describe('Migration 111 — phone_rate_limits', () => {
  const sql = MIGRATIONS['111_phone_rate_limits'];

  it('is registered in MIGRATIONS', () => {
    expect(sql).toBeDefined();
  });

  it('creates the table idempotently with the documented columns', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS phone_rate_limits/);
    expect(sql).toMatch(/tenant_id\s+UUID\s+NOT NULL\s+REFERENCES tenants\(id\)/);
    expect(sql).toMatch(/scope\s+TEXT\s+NOT NULL/);
    expect(sql).toMatch(/key\s+TEXT\s+NOT NULL/);
    expect(sql).toMatch(/window_start\s+TIMESTAMPTZ\s+NOT NULL/);
    expect(sql).toMatch(/count\s+INT\s+NOT NULL/);
  });

  it('keys on (tenant_id, scope, key, window_start) — the lookup index', () => {
    expect(sql).toMatch(
      /PRIMARY KEY \(tenant_id,\s*scope,\s*key,\s*window_start\)/,
    );
  });

  it('enables RLS with a tenant-isolation policy', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY tenant_isolation_phone_rate_limits/);
    expect(sql).toMatch(
      /tenant_id = current_setting\('app\.current_tenant_id'\)::UUID/,
    );
  });
});
