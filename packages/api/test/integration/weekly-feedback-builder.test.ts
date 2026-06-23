/**
 * Postgres integration — weekly feedback snapshot builder (Epic 12.6).
 *
 * The builder runs raw SQL against payments / jobs / estimates /
 * voice_sessions / leads / invoices and relies on tenant RLS
 * (setTenantContext). Unit tests mock the snapshot, so they can't catch a
 * wrong column name — exactly the failure CLAUDE.md calls out (the entity
 * resolver shipped a nonexistent column behind a mocked Pool). Running the
 * real builder pins every column reference against the live schema (an
 * empty tenant exercises all six queries) and pins the voice-call windowing
 * with seeded rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { buildWeeklyFeedbackSnapshot } from '../../src/digest/weekly-feedback-builder';

const WEEK_START = new Date('2026-06-01T00:00:00.000Z');
const WEEK_END = new Date('2026-06-08T00:00:00.000Z');

describe('Postgres integration — weekly feedback builder', () => {
  let pool: Pool;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('returns an all-zero snapshot for an empty tenant (every column resolves)', async () => {
    const snap = await buildWeeklyFeedbackSnapshot(pool, tenant.tenantId, WEEK_START, WEEK_END);
    expect(snap).toMatchObject({
      revenueCents: 0,
      priorRevenueCents: 0,
      invoicesPaidCount: 0,
      jobsCompleted: 0,
      priorJobsCompleted: 0,
      jobsBooked: 0,
      estimatesSent: 0,
      callsAnswered: 0,
      newLeads: 0,
      outstandingCents: 0,
    });
    expect(snap.weekStartIso).toBe(WEEK_START.toISOString());
  });

  it('counts answered inbound calls inside the week window only', async () => {
    // Seed two ended inbound calls: one inside the window, one before it, plus
    // a failed call that must not count as answered.
    const insert = async (endedAt: string, outcome: string) => {
      await pool.query(
        `INSERT INTO voice_sessions (tenant_id, channel, state, started_at, ended_at, outcome)
         VALUES ($1, 'voice_inbound', 'ended', $2, $2, $3)`,
        [tenant.tenantId, endedAt, outcome],
      );
    };
    await insert('2026-06-03T10:00:00.000Z', 'completed'); // in window, answered
    await insert('2026-05-20T10:00:00.000Z', 'completed'); // before window
    await insert('2026-06-04T10:00:00.000Z', 'failed'); // in window but not answered

    const snap = await buildWeeklyFeedbackSnapshot(pool, tenant.tenantId, WEEK_START, WEEK_END);
    expect(snap.callsAnswered).toBe(1);
  });
});
