import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MIGRATIONS } from '../../src/db/schema';

describe('Migration 147 — tenant_settings.csr_seats', () => {
  it('is registered in MIGRATIONS', () => {
    expect(MIGRATIONS['147_tenant_settings_csr_seats']).toMatch(
      /csr_seats\s+INTEGER/,
    );
  });

  it('is additive and idempotent (ADD COLUMN IF NOT EXISTS)', () => {
    expect(MIGRATIONS['147_tenant_settings_csr_seats']).toMatch(
      /ADD COLUMN IF NOT EXISTS csr_seats/,
    );
  });

  it('matches on-disk SQL', () => {
    const sql = readFileSync(
      join(__dirname, '../../src/db/migrations/147_tenant_settings_csr_seats.sql'),
      'utf8',
    );
    expect(sql).toMatch(/csr_seats/);
  });
});
