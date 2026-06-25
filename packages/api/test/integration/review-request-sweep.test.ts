/**
 * Integration test for the 24h review-request sweep (PRD US-345).
 *
 * Pins the eligibility SQL + migration-214 columns (jobs.review_request_sent_at,
 * tenant_settings.send_review_request) against REAL Postgres — a mocked-pool
 * unit test cannot prove the column names or the join exist (the CLAUDE.md
 * "entity resolver shipped nonexistent columns" rule).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { createLogger } from '../../src/logging/logger';
import { runReviewRequestSweep } from '../../src/workers/review-request-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-06-25T12:00:00.000Z');
const now = () => NOW;
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

async function seedCustomerLocation(pool: Pool, tenantId: string, createdBy: string) {
  const customerId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, 'A', 'B', 'A B', $3)`,
    [customerId, tenantId, createdBy],
  );
  const locationId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, $3, '1 Main', 'Town', 'TX', '78701')`,
    [locationId, tenantId, customerId],
  );
  return { customerId, locationId };
}

async function seedCompletedJob(
  pool: Pool,
  tenantId: string,
  ids: { customerId: string; locationId: string },
  completedAt: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, status, created_by, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'Service', 'completed', 'u1', $6)`,
    [id, tenantId, ids.customerId, ids.locationId, 'JOB-' + id.slice(0, 8), completedAt],
  );
  return id;
}

describe('review-request sweep (US-345, DB-level)', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };
  let jobOldA = '';
  let jobRecentA = '';
  let jobOldB = '';

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    // Tenant A: send_review_request defaults TRUE (migration 214 column default).
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name) VALUES (gen_random_uuid(), $1, 'A Co')`,
      [tenantA.tenantId],
    );
    // Tenant B: opted OUT.
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, send_review_request)
       VALUES (gen_random_uuid(), $1, 'B Co', FALSE)`,
      [tenantB.tenantId],
    );

    const idsA = await seedCustomerLocation(pool, tenantA.tenantId, tenantA.userId);
    const idsB = await seedCustomerLocation(pool, tenantB.tenantId, tenantB.userId);

    jobOldA = await seedCompletedJob(pool, tenantA.tenantId, idsA, hoursAgo(48)); // eligible
    jobRecentA = await seedCompletedJob(pool, tenantA.tenantId, idsA, hoursAgo(1)); // < 24h
    jobOldB = await seedCompletedJob(pool, tenantB.tenantId, idsB, hoursAgo(48)); // opted out
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('column default: tenant_settings.send_review_request defaults TRUE (migration 214)', async () => {
    const { rows } = await pool.query<{ send_review_request: boolean }>(
      `SELECT send_review_request FROM tenant_settings WHERE tenant_id = $1`,
      [tenantA.tenantId],
    );
    expect(rows[0].send_review_request).toBe(true);
  });

  it('enqueues feedback_send only for the eligible job, stamps it, and is idempotent', async () => {
    const send = vi.fn(async () => 'msg');

    const first = await runReviewRequestSweep({ pool, jobRepo, queue: { send }, logger, now });

    // Only the >24h job under the opted-in tenant.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'feedback_send',
      { tenantId: tenantA.tenantId, jobId: jobOldA },
      `${tenantA.tenantId}:${jobOldA}:feedback_send`,
    );
    expect(first.enqueued).toBe(1);

    // Stamp persisted (real column).
    const stamped = await pool.query<{ review_request_sent_at: Date | null }>(
      `SELECT review_request_sent_at FROM jobs WHERE id = $1`,
      [jobOldA],
    );
    expect(stamped.rows[0].review_request_sent_at).not.toBeNull();

    // The recent job and the opted-out tenant's job are untouched.
    const untouched = await pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE id = ANY($1) AND review_request_sent_at IS NULL`,
      [[jobRecentA, jobOldB]],
    );
    expect(untouched.rows.map((r) => r.id).sort()).toEqual([jobRecentA, jobOldB].sort());

    // Second sweep: the stamped job is no longer eligible → no new enqueue.
    send.mockClear();
    const second = await runReviewRequestSweep({ pool, jobRepo, queue: { send }, logger, now });
    expect(send).not.toHaveBeenCalled();
    expect(second.enqueued).toBe(0);
  });
});
