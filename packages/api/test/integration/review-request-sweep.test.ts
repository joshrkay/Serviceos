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
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgFeedbackRequestRepository } from '../../src/feedback/pg-feedback-request';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { MessageDeliveryFeedbackDispatcher } from '../../src/feedback/dispatcher';
import { createFeedbackSendWorker } from '../../src/workers/feedback-send';
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

    await runReviewRequestSweep({ pool, jobRepo, queue: { send }, logger, now });

    // runReviewRequestSweep is a GLOBAL cross-tenant sweep, so in the full
    // integration suite other files' eligible jobs also enqueue here. Scope the
    // count to THIS test's two tenants: exactly the >24h opted-in job (jobOldA)
    // enqueues — never the <24h job (jobRecentA) or the opted-out tenant's job.
    const ourCalls = send.mock.calls.filter(
      ([, payload]: [unknown, { tenantId: string }]) =>
        payload.tenantId === tenantA.tenantId || payload.tenantId === tenantB.tenantId,
    );
    expect(ourCalls).toHaveLength(1);
    expect(ourCalls[0]).toEqual([
      'feedback_send',
      { tenantId: tenantA.tenantId, jobId: jobOldA },
      `${tenantA.tenantId}:${jobOldA}:feedback_send`,
    ]);

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

    // Second sweep: the stamped job is no longer eligible → our tenants enqueue
    // nothing new (scoped, since other files' jobs may still be in play globally).
    send.mockClear();
    await runReviewRequestSweep({ pool, jobRepo, queue: { send }, logger, now });
    const ourSecondCalls = send.mock.calls.filter(
      ([, payload]: [unknown, { tenantId: string }]) =>
        payload.tenantId === tenantA.tenantId || payload.tenantId === tenantB.tenantId,
    );
    expect(ourSecondCalls).toHaveLength(0);
  });

  /**
   * G1 (#1009 on #1013): this file already proved the sweep's own write
   * (review_request_sent_at) at real Postgres, but its audit leg was never
   * exercised — `runReviewRequestSweep` itself writes no audit event; it
   * only enqueues `feedback_send`, whose central consent gate
   * (GatedMessageDelivery, notifications/gated-message-delivery.ts) is what
   * actually writes `sms.suppressed` in 'block' mode. Every existing test of
   * that gate (test/feedback/feedback-send-worker.test.ts) wires it with
   * `InMemoryAuditRepository` — never proven against real Postgres.
   *
   * This test runs the sweep's enqueue through the REAL feedback_send worker
   * (not a `vi.fn` queue stub) with every dependency backed by its real Pg
   * repository, forces a deterministic suppression (smsConsent: false), and
   * reads the resulting audit row back via `PgAuditRepository.findByEntity`
   * — the swap the row's G1 note calls for.
   *
   * T4 (per-tenant fan-out through the real enumerator) for THIS sweep is
   * already proven separately: test/integration/sweep-tenant-fanout.test.ts
   * ("cross-tenant query sweep fan-out (T4)" → "review-request sweep",
   * lines 1034-1072) drives runReviewRequestSweep against a multi-tenant
   * result set and asserts per-tenant enqueue + failure isolation. This test
   * is scoped to the audit leg alone and does not re-prove fan-out.
   */
  it('the enqueued feedback_send, once processed by the real gate, writes a real audit_events row (PgAuditRepository)', async () => {
    const tenant = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name) VALUES (gen_random_uuid(), $1, 'Audit Co')`,
      [tenant.tenantId],
    );

    const customerId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, primary_phone, preferred_channel, sms_consent, created_by)
       VALUES ($1, $2, 'No', 'Consent', 'No Consent', '+15555550199', 'sms', FALSE, $3)`,
      [customerId, tenant.tenantId, tenant.userId],
    );
    const locationId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, '1 Main', 'Town', 'TX', '78701')`,
      [locationId, tenant.tenantId, customerId],
    );
    const jobId = await seedCompletedJob(pool, tenant.tenantId, { customerId, locationId }, hoursAgo(48));

    const customerRepo = new PgCustomerRepository(pool);
    const settingsRepo = new PgSettingsRepository(pool);
    const feedbackRequestRepo = new PgFeedbackRequestRepository(pool);
    const dncRepo = new PgDncRepository(pool);
    const auditRepo = new PgAuditRepository(pool);

    const gated = new GatedMessageDelivery({
      base: new InMemoryDeliveryProvider(),
      dnc: dncRepo,
      auditRepo,
      enforcement: 'block',
      // Pin the SMS kill switch explicitly ON. sendSms() checks this BEFORE
      // evaluating consent (gated-message-delivery.ts) — an inherited
      // TELEPHONY_ENABLED=false from a developer's shell or a CI env would
      // short-circuit to `channel_disabled` and skip the audit write
      // entirely, so this test would silently stop proving anything rather
      // than fail loud. Caught in review (Codex) on this PR.
      env: { ...process.env, TELEPHONY_ENABLED: 'true' },
    });
    const dispatcher = new MessageDeliveryFeedbackDispatcher(gated);
    const worker = createFeedbackSendWorker({
      jobRepo,
      customerRepo,
      settingsRepo,
      feedbackRequestRepo,
      dispatcher,
      publicBaseUrl: 'https://app.example.com',
    });

    // The sweep's own `queue.send` — wired to the REAL worker instead of a
    // recording stub, so the gate it drives through is the production one.
    await runReviewRequestSweep({
      pool,
      jobRepo,
      queue: {
        send: async (_kind, payload: unknown, idemKey: string) => {
          await worker.handle(
            {
              id: uuidv4(),
              type: 'feedback_send',
              payload: payload as { tenantId: string; jobId: string },
              attempts: 1,
              maxAttempts: 3,
              idempotencyKey: idemKey,
              createdAt: new Date().toISOString(),
            },
            logger,
          );
        },
      },
      logger,
      now,
    });

    const events = await auditRepo.findByEntity(tenant.tenantId, 'sms_message', customerId);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('sms.suppressed');
    expect((events[0].metadata as Record<string, unknown>).reason).toBe('no_consent');

    // The sweep's own stamp still lands (unaffected by the gate's decision).
    const stamped = await pool.query<{ review_request_sent_at: Date | null }>(
      `SELECT review_request_sent_at FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(stamped.rows[0].review_request_sent_at).not.toBeNull();
  });
});
