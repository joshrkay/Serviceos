/**
 * Postgres integration — daily-digest worker (RV-061 / F-9).
 *
 * The worker's compute / due-bucket / fallback-narrative logic is fully
 * covered by test/workers/daily-digest-worker.test.ts against in-memory
 * repositories. That suite proves the orchestration but cannot prove the
 * Postgres-level guards the worker leans on for double-send safety:
 *
 *   1. daily_digests UNIQUE(tenant_id, digest_date) — the worker writes
 *      via insertIfAbsent and only the inserter sends the SMS.
 *   2. PgDailyDigestRepository.setSmsDispatchId UPDATE … WHERE
 *      sms_dispatch_id IS NULL — the retry-claim guard.
 *   3. PgSettingsRepository.findByTenant returning the digest_enabled /
 *      digest_time / digest_channel / owner_phone columns added by
 *      migration RV-063.
 *
 * This file drives runDailyDigestSweep with the production Pg repos for
 * (1)–(3) and stubbed compute deps (already proven by the unit test) so
 * the SQL the worker actually executes in production is pinned end-to-end.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { runDailyDigestSweep } from '../../src/workers/daily-digest-worker';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgDailyDigestRepository } from '../../src/digest/pg-daily-digest';
import { PgDispatchRepository } from '../../src/notifications/dispatch-repository';
import type { DigestComputeDeps } from '../../src/digest/digest-service';
import type { MessageDeliveryProvider } from '../../src/notifications/delivery-provider';
import type { PaymentRepository } from '../../src/invoices/payment';
import type { InvoiceRepository } from '../../src/invoices/invoice';
import type { EstimateRepository } from '../../src/estimates/estimate';
import type { JobRepository } from '../../src/jobs/job';
import type { AppointmentRepository } from '../../src/appointments/appointment';
import type { ProposalRepository } from '../../src/proposals/proposal';
import type { CustomerRepository } from '../../src/customers/customer';
import type { FeedbackResponseRepository } from '../../src/feedback/feedback-response';
import type { SettingsRepository } from '../../src/settings/settings';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

// 2026-06-11 18:05 in America/Chicago (CDT = UTC-5) → 23:05Z.  digest_time
// '18:00' falls inside the just-passed 15-min bucket (17:50, 18:05].
const TZ = 'America/Chicago';
const DUE_NOW = new Date('2026-06-11T23:05:00.000Z');
const LOCAL_DATE = '2026-06-11';

/**
 * Stub the 8 read-only compute repos with empty results — the digest
 * payload composition is already pinned by the unit test against the
 * same stubs.  We're here for the Pg write/idempotency paths.
 */
function emptyComputeDeps(settingsRepo: SettingsRepository): DigestComputeDeps {
  return {
    paymentRepo: { findByTenant: async () => [] } as unknown as PaymentRepository,
    jobRepo: { findByTenant: async () => [] } as unknown as JobRepository,
    appointmentRepo: { findByDateRange: async () => [] } as unknown as AppointmentRepository,
    invoiceRepo: {
      findByTenant: async () => [],
      findByJobs: async () => [],
    } as unknown as InvoiceRepository,
    estimateRepo: { findByJobs: async () => [] } as unknown as EstimateRepository,
    proposalRepo: { findByStatus: async () => [] } as unknown as ProposalRepository,
    customerRepo: { findById: async () => null } as unknown as CustomerRepository,
    settingsRepo,
    feedbackResponseRepo: {
      countByRatingInRange: async () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }),
    } as unknown as FeedbackResponseRepository,
  };
}

interface CapturedSms {
  to: string;
  body: string;
  tenantId?: string;
  idempotencyKey?: string;
}

function makeCapturingDelivery(): {
  delivery: Pick<MessageDeliveryProvider, 'sendSms'>;
  calls: CapturedSms[];
} {
  const calls: CapturedSms[] = [];
  return {
    calls,
    delivery: {
      async sendSms(input) {
        calls.push({
          to: input.to,
          body: input.body,
          ...(input.tenantId ? { tenantId: input.tenantId } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        });
        return { provider: 'twilio', providerMessageId: `SM${uuidv4().slice(0, 8)}`, channel: 'sms' };
      },
    },
  };
}

describe('Postgres integration — daily-digest worker', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let digestRepo: PgDailyDigestRepository;
  let dispatchRepo: PgDispatchRepository;
  let tenant: { tenantId: string; userId: string };
  let ownerPhone: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    digestRepo = new PgDailyDigestRepository(pool);
    dispatchRepo = new PgDispatchRepository(pool);
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
    // Unique per-test phone so dispatcher captures can be filtered to
    // this test's seed in the shared-container model.
    ownerPhone = `+1555${tenant.tenantId.replace(/-/g, '').slice(0, 7)}`;
    await pool.query(
      `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone,
        owner_phone, digest_enabled, digest_time, digest_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [uuidv4(), tenant.tenantId, 'Acme HVAC', TZ, ownerPhone, true, '18:00', 'sms'],
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('inserts a daily_digests row and claims the message_dispatches row when due', async () => {
    const { delivery, calls } = makeCapturingDelivery();

    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: emptyComputeDeps(settingsRepo),
      listTenantIds: async () => [tenant.tenantId],
      delivery,
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });

    expect(result.generated).toBe(1);
    expect(result.sent).toBe(1);

    // Persisted digest row with the tenant-local effective date.
    const stored = await digestRepo.findByTenantAndDate(tenant.tenantId, LOCAL_DATE);
    expect(stored).not.toBeNull();
    expect(stored!.payload.date).toBe(LOCAL_DATE);
    expect(stored!.payload.timezone).toBe(TZ);
    expect(stored!.smsDispatchId).not.toBeUndefined();

    // Dispatch row exists and carries the daily_digest:<date> idempotency key.
    const dispatches = await dispatchRepo.findByEntity(
      tenant.tenantId,
      'daily_digest',
      stored!.id,
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].idempotencyKey).toBe(`daily_digest:${LOCAL_DATE}`);
    expect(dispatches[0].recipient).toBe(ownerPhone);
    expect(stored!.smsDispatchId).toBe(dispatches[0].id);

    // Capturing delivery saw exactly the one SMS this tenant should fire.
    const ourCalls = calls.filter((c) => c.tenantId === tenant.tenantId);
    expect(ourCalls).toHaveLength(1);
    expect(ourCalls[0].to).toBe(ownerPhone);
    expect(ourCalls[0].idempotencyKey).toBe(`daily_digest:${LOCAL_DATE}`);
  });

  it('does not duplicate the digest or re-send on a second sweep (UNIQUE + IS NULL guards)', async () => {
    const first = makeCapturingDelivery();
    await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: emptyComputeDeps(settingsRepo),
      listTenantIds: async () => [tenant.tenantId],
      delivery: first.delivery,
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });
    expect(first.calls.filter((c) => c.tenantId === tenant.tenantId)).toHaveLength(1);

    // Second sweep at the same tick: the UNIQUE(tenant, date) constraint
    // makes insertIfAbsent a no-op, and the now-stored sms_dispatch_id
    // short-circuits before any new SMS goes out.
    const second = makeCapturingDelivery();
    const result = await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: emptyComputeDeps(settingsRepo),
      listTenantIds: async () => [tenant.tenantId],
      delivery: second.delivery,
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });
    expect(result.generated).toBe(0);
    expect(result.sent).toBe(0);
    expect(second.calls.filter((c) => c.tenantId === tenant.tenantId)).toHaveLength(0);

    // Exactly one row in daily_digests for this tenant + date.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM daily_digests
       WHERE tenant_id = $1 AND digest_date = $2::date`,
      [tenant.tenantId, LOCAL_DATE],
    );
    expect(rows[0].n).toBe(1);

    // Exactly one dispatch row for this digest.
    const stored = await digestRepo.findByTenantAndDate(tenant.tenantId, LOCAL_DATE);
    const dispatches = await dispatchRepo.findByEntity(
      tenant.tenantId,
      'daily_digest',
      stored!.id,
    );
    expect(dispatches).toHaveLength(1);
  });

  it('skips a tenant whose digest_enabled is false (PgSettings read path)', async () => {
    await pool.query(
      `UPDATE tenant_settings SET digest_enabled = FALSE WHERE tenant_id = $1`,
      [tenant.tenantId],
    );

    const { delivery, calls } = makeCapturingDelivery();
    await runDailyDigestSweep({
      settingsRepo,
      digestRepo,
      computeDeps: emptyComputeDeps(settingsRepo),
      listTenantIds: async () => [tenant.tenantId],
      delivery,
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      logger,
      now: () => DUE_NOW,
    });

    // No digest row, no SMS, no dispatch.
    const stored = await digestRepo.findByTenantAndDate(tenant.tenantId, LOCAL_DATE);
    expect(stored).toBeNull();
    expect(calls.filter((c) => c.tenantId === tenant.tenantId)).toHaveLength(0);
  });
});
