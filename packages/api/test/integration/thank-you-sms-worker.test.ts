import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgDncRepository } from '../../src/compliance/dnc';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createLogger } from '../../src/logging/logger';
import type { FeedbackDispatcher } from '../../src/feedback/dispatcher';
import { runThankYouSmsSweep } from '../../src/workers/thank-you-sms-worker';
import {
  transitionJobStatus,
  JOB_TIMELINE_EVENT_TYPES,
  InMemoryJobTimelineRepository,
} from '../../src/jobs/job-lifecycle';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const NOW = new Date('2026-06-17T15:00:00Z');
const FOUR_HOURS_AGO = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);

interface CapturedSend {
  to: string;
  body: string;
}

function makeCapturingDispatcher(): { dispatcher: FeedbackDispatcher; calls: CapturedSend[] } {
  const calls: CapturedSend[] = [];
  return {
    calls,
    dispatcher: {
      async send(input) {
        calls.push(input);
      },
    },
  };
}

describe('thank-you-sms worker — integration', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let dncRepo: PgDncRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    dncRepo = new PgDncRepository(pool);
    auditRepo = new PgAuditRepository(pool);
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
    // Seed minimal tenant_settings row (defaults to send_thank_you_sms = TRUE).
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), tenant.tenantId, 'Acme Plumbing', 'America/Phoenix'],
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedCustomerAndJob(opts: {
    primaryPhone?: string;
    smsConsent?: boolean;
    completedAtAgo: 'four_hours' | 'one_hour';
  }): Promise<{ customerId: string; jobId: string; locationId: string; phone: string }> {
    const customerId = uuidv4();
    // Unique-per-call phone so a test that runs the sweep across all
    // tenants in the shared container can still scope its dispatcher
    // assertions to the seed it owns.
    const phone = opts.primaryPhone ?? `+1555${customerId.replace(/-/g, '').slice(0, 7)}`;
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name,
        primary_phone, preferred_channel, sms_consent, is_archived, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        customerId, tenant.tenantId, 'Mary', 'Johnson', 'Mary Johnson',
        phone, 'sms', opts.smsConsent ?? true, false, tenant.userId,
      ],
    );

    const locationId = uuidv4();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [locationId, tenant.tenantId, customerId, '1 Main St', 'Phoenix', 'AZ', '85001', 'US'],
    );

    const jobId = uuidv4();
    // jobs has a UNIQUE (tenant_id, job_number) index, so two seeds in
    // a single test against the same tenant must use distinct numbers.
    const jobNumber = `JOB-${jobId.slice(0, 8)}`;
    const completedAt =
      opts.completedAtAgo === 'four_hours' ? FOUR_HOURS_AGO : new Date(NOW.getTime() - 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary,
        status, priority, created_by, completed_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'completed','normal',$7,$8, NOW(), NOW())`,
      [jobId, tenant.tenantId, customerId, locationId, jobNumber, 'Test job', tenant.userId, completedAt],
    );

    return { customerId, jobId, locationId, phone };
  }

  it('selects only jobs whose completed_at is older than the delay and whose tenant has the toggle on', async () => {
    const a = await seedCustomerAndJob({ completedAtAgo: 'four_hours' });
    const b = await seedCustomerAndJob({ completedAtAgo: 'one_hour' });

    const { dispatcher, calls } = makeCapturingDispatcher();
    await runThankYouSmsSweep({
      pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
      now: () => NOW,
    });

    // Tenant-scoped assertions: the sweep iterates every tenant in the
    // shared container, so other tests' fixtures can ride in the
    // aggregate counts. Filter dispatcher captures by THIS test's
    // unique phones and pin column writes on the seeded ids.
    const ourCalls = calls.filter((c) => c.to === a.phone || c.to === b.phone);
    expect(ourCalls.map((c) => c.to)).toEqual([a.phone]);
    expect(ourCalls[0].body).toContain('Acme Plumbing');

    const aRow = await pool.query(`SELECT thank_you_sms_sent_at FROM jobs WHERE id = $1`, [a.jobId]);
    expect(aRow.rows[0].thank_you_sms_sent_at).not.toBeNull();
    const bRow = await pool.query(`SELECT thank_you_sms_sent_at FROM jobs WHERE id = $1`, [b.jobId]);
    expect(bRow.rows[0].thank_you_sms_sent_at).toBeNull();
  });

  it('skips a tenant whose send_thank_you_sms is FALSE', async () => {
    await pool.query(
      `UPDATE tenant_settings SET send_thank_you_sms = FALSE WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    const seed = await seedCustomerAndJob({ completedAtAgo: 'four_hours' });

    const { dispatcher, calls } = makeCapturingDispatcher();
    await runThankYouSmsSweep({
      pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
      now: () => NOW,
    });

    // Tenant-scoped assertions (see prior test's note).
    expect(calls.some((c) => c.to === seed.phone)).toBe(false);
    const row = await pool.query(`SELECT thank_you_sms_sent_at FROM jobs WHERE id = $1`, [seed.jobId]);
    expect(row.rows[0].thank_you_sms_sent_at).toBeNull();
  });

  it('is idempotent — a second sweep on the same data does not re-send', async () => {
    const seed = await seedCustomerAndJob({ completedAtAgo: 'four_hours' });

    const { dispatcher, calls } = makeCapturingDispatcher();
    await runThankYouSmsSweep({
      pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
      now: () => NOW,
    });
    expect(calls.filter((c) => c.to === seed.phone).length).toBe(1);

    await runThankYouSmsSweep({
      pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
      now: () => NOW,
    });
    // Idempotency: the second sweep must not re-call this tenant's phone.
    expect(calls.filter((c) => c.to === seed.phone).length).toBe(1);
  });

  it('writes a notification.thank_you_sms.sent audit event scoped to the job entity', async () => {
    const { jobId } = await seedCustomerAndJob({ completedAtAgo: 'four_hours' });

    const { dispatcher } = makeCapturingDispatcher();
    await runThankYouSmsSweep({
      pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
      now: () => NOW,
    });

    const events = await auditRepo.findByEntity(tenant.tenantId, 'job', jobId);
    expect(events.some((e) => e.eventType === 'notification.thank_you_sms.sent')).toBe(true);
  });

  it('transitionJobStatus stamps completed_at on the in_progress → completed transition', async () => {
    // Insert a fresh non-completed job (skipping the completed_at backfill path).
    const customerId = uuidv4();
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, preferred_channel, sms_consent, is_archived, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [customerId, tenant.tenantId, 'A', 'B', 'A B', 'sms', true, false, tenant.userId],
    );
    const locationId = uuidv4();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [locationId, tenant.tenantId, customerId, '1 Main', 'Phoenix', 'AZ', '85001', 'US'],
    );
    const jobId = uuidv4();
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary,
        status, priority, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'job','in_progress','normal',$6, NOW(), NOW())`,
      [jobId, tenant.tenantId, customerId, locationId, 'JOB-0002', tenant.userId],
    );

    const timelineRepo = new InMemoryJobTimelineRepository();
    const { job } = await transitionJobStatus(
      tenant.tenantId, jobId, 'completed', tenant.userId, 'owner', jobRepo, timelineRepo, auditRepo,
    );
    expect(job.completedAt).toBeInstanceOf(Date);
    expect(job.completedAt!.getTime()).toBeGreaterThan(NOW.getTime() - 60_000);
    // sanity: timeline ref kept; the JOB_TIMELINE_EVENT_TYPES import is exercised
    expect(JOB_TIMELINE_EVENT_TYPES.STATUS_CHANGE).toBeDefined();
  });

  describe('T4-F01 — claim-before-send against real send_claims', () => {
    it('reclaims a stale send_claims row and sends (crash between claim and send)', async () => {
      const seed = await seedCustomerAndJob({ completedAtAgo: 'four_hours' });
      await pool.query(
        `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
         VALUES ($1, $2, 'claimed', NOW() - INTERVAL '20 minutes')`,
        [tenant.tenantId, `thank_you_sms:${seed.jobId}`],
      );

      const { dispatcher, calls } = makeCapturingDispatcher();
      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
        now: () => NOW,
      });

      expect(calls.some((c) => c.to === seed.phone)).toBe(true);
      const row = await pool.query(`SELECT thank_you_sms_sent_at FROM jobs WHERE id = $1`, [seed.jobId]);
      expect(row.rows[0].thank_you_sms_sent_at).not.toBeNull();
      const claimRow = await pool.query(
        `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
        [tenant.tenantId, `thank_you_sms:${seed.jobId}`],
      );
      expect(claimRow.rows[0].status).toBe('sent');
    });

    it('Codex P2 (PR #705) — does NOT resend when a "sent" claim exists but thank_you_sms_sent_at is still NULL, and RECONCILES the missing stamp (crash between send and mark)', async () => {
      const seed = await seedCustomerAndJob({ completedAtAgo: 'four_hours' });
      await pool.query(
        `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at, sent_at)
         VALUES ($1, $2, 'sent', NOW(), NOW())`,
        [tenant.tenantId, `thank_you_sms:${seed.jobId}`],
      );

      const { dispatcher, calls } = makeCapturingDispatcher();
      await runThankYouSmsSweep({
        pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
        now: () => NOW,
      });

      // No resend (the SMS already went out), but the missing stamp is now
      // reconciled — otherwise the eligibility query re-selects this job every
      // tick forever and can starve newer jobs (oldest-first, LIMIT 500).
      expect(calls.some((c) => c.to === seed.phone)).toBe(false);
      const row = await pool.query(`SELECT thank_you_sms_sent_at FROM jobs WHERE id = $1`, [seed.jobId]);
      expect(row.rows[0].thank_you_sms_sent_at).toEqual(NOW);
    });

    it('two concurrent sweeps against the same eligible job send exactly once', async () => {
      const seed = await seedCustomerAndJob({ completedAtAgo: 'four_hours' });
      const { dispatcher, calls } = makeCapturingDispatcher();

      await Promise.all([
        runThankYouSmsSweep({
          pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
          now: () => NOW,
        }),
        runThankYouSmsSweep({
          pool, jobRepo, customerRepo, settingsRepo, dncRepo, dispatcher, auditRepo, logger,
          now: () => NOW,
        }),
      ]);

      expect(calls.filter((c) => c.to === seed.phone)).toHaveLength(1);
    });
  });
});
