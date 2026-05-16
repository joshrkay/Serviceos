// packages/api/test/db/migration-098.test.ts
import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

describe('Migration 098 — tenant_settings onboarding fields', () => {
  const sql = MIGRATIONS['098_tenant_settings_onboarding_fields'];

  it('is registered in the MIGRATIONS map', () => {
    expect(sql).toBeDefined();
    expect(typeof sql).toBe('string');
  });
  it('adds business_hours JSONB with default', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS business_hours\s+JSONB\s+NOT NULL DEFAULT '\{\}'/);
  });
  it('adds job_buffer_minutes INT with default 30', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS job_buffer_minutes\s+INT\s+NOT NULL DEFAULT 30/);
  });
  it('adds hourly_rate_cents INT (nullable)', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS hourly_rate_cents\s+INT(?!\s+NOT)/);
  });
  it('adds service_area_text and service_area_radius', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS service_area_text\s+TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS service_area_radius\s+INT/);
  });
  it('adds onboarding_test_call_skipped_at + onboarding_upgrade_prompt_shown_at', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS onboarding_test_call_skipped_at\s+TIMESTAMPTZ/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS onboarding_upgrade_prompt_shown_at\s+TIMESTAMPTZ/);
  });
});
