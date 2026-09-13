/**
 * §8.9 row 9.2 — rung-5 REACHABILITY for the 24h review-request sweep.
 *
 * The row is already at "4" (PR #1070): `review-request-sweep.test.ts`
 * proves the sweep's own write (review_request_sent_at, idempotent across
 * two sweeps, defaulting ON at the tenant_settings column) AND, separately,
 * that the enqueued `feedback_send`, once processed by the REAL production
 * gate (GatedMessageDelivery, PgAuditRepository, enforcement: 'block'),
 * writes a real audit_events row. What that second test does NOT do is put
 * both proofs in the SAME run with two tenants running side by side and an
 * explicit cross-tenant audit-isolation check (T2) — every existing case
 * uses exactly one ad-hoc tenant. This file is the "keep the sweep angle"
 * instruction: no browser surface exists for a background sweep, so
 * reachability here means driving the REAL sweep → REAL feedback_send
 * worker → REAL gate → REAL Postgres audit read-back, for two tenants in
 * one sweep call, with one tenant's consenting send and the other's
 * DNC-suppressed send never crossing tenant lines.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgFeedbackRequestRepository } from '../../src/feedback/pg-feedback-request';
import { PgDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { MessageDeliveryFeedbackDispatcher } from '../../src/feedback/dispatcher';
import { createFeedbackSendWorker } from '../../src/workers/feedback-send';
import { createLogger } from '../../src/logging/logger';
import { runReviewRequestSweep } from '../../src/workers/review-request-worker';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-06-26T12:00:00.000Z');
const now = () => NOW;
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

async function seedTenant(
  pool: Pool,
  opts: { smsConsent: boolean; onDnc?: boolean },
): Promise<{ tenantId: string; userId: string; customerId: string; jobId: string; phone: string }> {
  const tenant = await createTestTenant(pool);
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name) VALUES (gen_random_uuid(), $1, $2)`,
    [tenant.tenantId, 'Co ' + tenant.tenantId.slice(0, 6)],
  );

  const customerId = uuidv4();
  const phone = `+1555${customerId.replace(/-/g, '').slice(0, 7)}`;
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, primary_phone, preferred_channel, sms_consent, created_by)
     VALUES ($1, $2, 'A', 'B', 'A B', $3, 'sms', $4, $5)`,
    [customerId, tenant.tenantId, phone, opts.smsConsent, tenant.userId],
  );
  if (opts.onDnc) {
    const dncRepo = new PgDncRepository(pool);
    await dncRepo.addToDnc(tenant.tenantId, normalizePhone(phone), 'test-seed');
  }

  const locationId = uuidv4();
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, $3, '1 Main', 'Town', 'TX', '78701')`,
    [locationId, tenant.tenantId, customerId],
  );

  const jobId = uuidv4();
  await pool.query(
    `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, status, created_by, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'Service', 'completed', $6, $7)`,
    [jobId, tenant.tenantId, customerId, locationId, 'JOB-' + jobId.slice(0, 8), tenant.userId, hoursAgo(48)],
  );

  return { tenantId: tenant.tenantId, userId: tenant.userId, customerId, jobId, phone };
}

describe('9.2 reachability — review-request sweep, one call, two tenants, through the real gate (T2)', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let settingsRepo: PgSettingsRepository;
  let feedbackRequestRepo: PgFeedbackRequestRepository;
  let dncRepo: PgDncRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    feedbackRequestRepo = new PgFeedbackRequestRepository(pool);
    dncRepo = new PgDncRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('tenant A (consenting) gets a real SMS + no suppression audit; tenant B (DNC) gets a suppression audit + no send — neither leaks into the other, both stamped exactly once across two sweeps', async () => {
    const a = await seedTenant(pool, { smsConsent: true });
    const b = await seedTenant(pool, { smsConsent: true, onDnc: true });

    const base = new InMemoryDeliveryProvider();
    const gate = new GatedMessageDelivery({
      base,
      dnc: dncRepo,
      auditRepo,
      enforcement: 'block',
      env: { ...process.env, TELEPHONY_ENABLED: 'true' },
    });
    const dispatcher = new MessageDeliveryFeedbackDispatcher(gate);
    const worker = createFeedbackSendWorker({
      jobRepo,
      customerRepo,
      settingsRepo,
      feedbackRequestRepo,
      dispatcher,
      publicBaseUrl: 'https://app.example.com',
    });

    const runOnce = () =>
      runReviewRequestSweep({
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
            return idemKey;
          },
        },
        logger,
        now,
      });

    await runOnce();

    // Tenant A: real send went out, gate did not suppress it.
    expect(base.sentSms.filter((m) => m.to === a.phone)).toHaveLength(1);
    const auditA = await auditRepo.findByEntity(a.tenantId, 'sms_message', a.customerId);
    expect(auditA.filter((e) => e.eventType === 'sms.suppressed')).toHaveLength(0);

    // Tenant B: DNC-suppressed by the real gate, one suppression audit row,
    // no send.
    expect(base.sentSms.filter((m) => m.to === b.phone)).toHaveLength(0);
    const auditB = await auditRepo.findByEntity(b.tenantId, 'sms_message', b.customerId);
    const suppressedB = auditB.filter((e) => e.eventType === 'sms.suppressed');
    expect(suppressedB).toHaveLength(1);
    expect((suppressedB[0].metadata as Record<string, unknown>).reason).toBe('dnc');

    // T2 isolation: tenant A's audit read never surfaces tenant B's row.
    const crossRead = await auditRepo.findByEntity(a.tenantId, 'sms_message', b.customerId);
    expect(crossRead).toHaveLength(0);

    // Both jobs stamped so a second sweep enqueues nothing new for either.
    const stampedA = await pool.query(`SELECT review_request_sent_at FROM jobs WHERE id = $1`, [a.jobId]);
    expect(stampedA.rows[0].review_request_sent_at).not.toBeNull();
    const stampedB = await pool.query(`SELECT review_request_sent_at FROM jobs WHERE id = $1`, [b.jobId]);
    expect(stampedB.rows[0].review_request_sent_at).not.toBeNull();

    base.sentSms.length = 0;
    await runOnce();
    expect(base.sentSms.filter((m) => m.to === a.phone || m.to === b.phone)).toHaveLength(0);
  });
});
