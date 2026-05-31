import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

describe('Migration 137 — technician_working_hours', () => {
  const sql = MIGRATIONS['137_technician_working_hours'];

  it('is registered in MIGRATIONS', () => {
    expect(sql).toBeDefined();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS technician_working_hours/);
  });

  it('is tenant-scoped with RLS forced', () => {
    expect(sql).toMatch(/tenant_id UUID NOT NULL REFERENCES tenants\(id\)/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY tenant_isolation_technician_working_hours/);
  });

  it('enforces one window per technician per weekday', () => {
    expect(sql).toMatch(/day_of_week SMALLINT NOT NULL CHECK \(day_of_week BETWEEN 0 AND 6\)/);
    expect(sql).toMatch(/UNIQUE \(tenant_id, technician_id, day_of_week\)/);
  });
});
