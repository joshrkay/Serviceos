import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/db/schema';

describe('Migration 254 — ai_runs.cost_micro_cents', () => {
  const sql = MIGRATIONS['254_ai_runs_cost_micro_cents'];

  it('is registered in MIGRATIONS', () => {
    expect(sql).toBeDefined();
  });

  it('adds a nullable BIGINT column idempotently (additive, no backfill needed)', () => {
    expect(sql).toMatch(
      /ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS cost_micro_cents BIGINT;/,
    );
    // Nullable: never NOT NULL — unpriced models must persist NULL, not a
    // guessed cost, and no default is safe to backfill onto historical rows.
    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).not.toMatch(/DEFAULT/);
  });

  it('never touches any other column (single additive change)', () => {
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME/i);
  });
});
