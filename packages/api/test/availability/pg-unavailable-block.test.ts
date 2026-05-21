import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgUnavailableBlockRepository } from '../../src/availability/pg-unavailable-block';
import type { UnavailableBlockRepository } from '../../src/availability/unavailable-block';
import { PgTechStatusTodayRepository } from '../../src/sms/tech-status/idempotency';
import type { TechStatusTodayRepository } from '../../src/sms/tech-status/idempotency';

/**
 * P6-028 — the Pg-backed repos require a live Postgres to exercise their SQL.
 * That lives under test/integration/** (CI testcontainer). Here we only assert
 * the structural contract: both classes construct from a Pool and satisfy
 * their interfaces (compile-time + a runtime instanceof / method-shape check).
 * The SQL itself is type-checked by the production tsc gate.
 */
describe('P6-028 tech-status — Pg repo structure (no live DB)', () => {
  // A Pool stub good enough to construct the repos. No query is executed.
  const poolStub = {} as unknown as Pool;

  it('PgUnavailableBlockRepository satisfies UnavailableBlockRepository', () => {
    const repo: UnavailableBlockRepository = new PgUnavailableBlockRepository(poolStub);
    expect(typeof repo.create).toBe('function');
    expect(typeof repo.findByTechnician).toBe('function');
    expect(typeof repo.findByTechnicianAndDateRange).toBe('function');
    expect(typeof repo.delete).toBe('function');
  });

  it('PgTechStatusTodayRepository satisfies TechStatusTodayRepository', () => {
    const repo: TechStatusTodayRepository = new PgTechStatusTodayRepository(poolStub);
    expect(typeof repo.claimToday).toBe('function');
    expect(typeof repo.findToday).toBe('function');
  });
});
