/**
 * §8.9 row 9.7 — rung-5 REACHABILITY for the weekly (Saturday) owner summary.
 *
 * The "total/repeats/rate come from the real corrections table, omitted at
 * zero" clause is already proven against real Postgres in
 * `weekly-feedback-builder.test.ts` (`repeatCorrections (WS22)` describe
 * block) — this file does not re-prove that content and cites it instead.
 * The owner-facing "cannot turn it off" gap was closed with a real browser
 * (`e2e/journeys/weekly-feedback-toggle.spec.ts`).
 *
 * What has NEVER been run against real Postgres is `runWeeklyFeedbackSweep`
 * itself: every existing test of the sweep (test/workers/weekly-feedback-
 * worker.test.ts) uses an in-memory `AuditRepository` stub, but the sweep's
 * entire idempotency ledger IS the audit repo — `findByEntity` before
 * sending, `create` only after a successful send (weekly-feedback-worker.ts).
 * The row's own acceptance ("the send ledger is idempotent and a failed send
 * leaves no row so the week retries") has only ever been checked against a
 * fake. This file drives the REAL sweep, with the REAL per-tenant config
 * resolvers (`digest/weekly-feedback-config.ts`, the same functions app.ts
 * wires in), against `PgAuditRepository`, with two tenants of DIVERGENT
 * config (T3: one opted in, one opted out) and DIVERGENT data (T2).
 *
 * Fan-out (T4) for this sweep across N tenants via the production tenant
 * selector is already proven in test/integration/sweep-tenant-fanout.test.ts
 * ("weekly-feedback" entry) — not re-proven here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { buildWeeklyFeedbackSnapshot } from '../../src/digest/weekly-feedback-builder';
import {
  resolveTenantOwnerEmail,
  isWeeklyFeedbackEnabledForTenant,
  resolveTenantBusinessName,
} from '../../src/digest/weekly-feedback-config';
import { runWeeklyFeedbackSweep, type WeeklyFeedbackEmailArgs } from '../../src/workers/weekly-feedback-worker';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
// Sweep computes "the most recently completed week" relative to `now`. Pin
// now to a Monday so [prevMonday, thisMonday) is a fixed, known window.
const NOW = new Date('2026-06-08T09:00:00.000Z'); // Monday
const WEEK_START = new Date('2026-06-01T00:00:00.000Z');

async function seedActiveJob(pool: Pool, tenantId: string, userId: string, updatedAt: Date): Promise<void> {
  const customerId = uuidv4();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, 'Cust', $3)`,
    [customerId, tenantId, userId],
  );
  const locationId = uuidv4();
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, $3, '1 Main', 'Town', 'TX', '78701')`,
    [locationId, tenantId, customerId],
  );
  const jobId = uuidv4();
  await pool.query(
    `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, status, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'Service', 'completed', $6, $7, $7)`,
    [jobId, tenantId, customerId, locationId, 'JOB-' + jobId.slice(0, 8), userId, updatedAt],
  );
}

describe('9.7 reachability — weekly feedback sweep at real Postgres (T2/T3)', () => {
  let pool: Pool;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('T3: opted-in tenant sends once (idempotent ledger via real audit rows); opted-out neighbour never sends; a failed send leaves no ledger row so the week retries', async () => {
    const tenantIn = await createTestTenant(pool);
    const tenantOut = await createTestTenant(pool);
    const tenantFail = await createTestTenant(pool);

    await settingsRepo.create({
      id: uuidv4(),
      tenantId: tenantIn.tenantId,
      businessName: 'In Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await settingsRepo.create({
      id: uuidv4(),
      tenantId: tenantOut.tenantId,
      businessName: 'Out Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // T3 — divergent per-tenant CONFIG: explicitly opted out.
    await settingsRepo.update(tenantOut.tenantId, { weeklyFeedbackEnabled: false });
    await settingsRepo.create({
      id: uuidv4(),
      tenantId: tenantFail.tenantId,
      businessName: 'Fail Co',
      timezone: 'America/Chicago',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // T2 — divergent DATA: each tenant gets its own completed job inside the
    // window so neither's week is "dead" (isEmptyWeek would skip the send).
    await seedActiveJob(pool, tenantIn.tenantId, tenantIn.userId, new Date('2026-06-03T12:00:00Z'));
    await seedActiveJob(pool, tenantOut.tenantId, tenantOut.userId, new Date('2026-06-03T12:00:00Z'));
    await seedActiveJob(pool, tenantFail.tenantId, tenantFail.userId, new Date('2026-06-03T12:00:00Z'));

    const sentEmails: WeeklyFeedbackEmailArgs[] = [];

    // Each tenant swept alone (its own call), so a forced send-failure is
    // deterministic per tenant without needing to key off the tenant inside
    // the shared `sendEmail` closure. This is still the REAL sweep function
    // and the REAL per-tenant config resolvers — only the "which tenants
    // does this call cover" batching is narrowed.
    const runFor = (tenantId: string, shouldFail: boolean) =>
      runWeeklyFeedbackSweep({
        auditRepo,
        buildSnapshot: (tid, weekStart, weekEnd) => buildWeeklyFeedbackSnapshot(pool, tid, weekStart, weekEnd),
        resolveOwnerEmail: (tid) => resolveTenantOwnerEmail(pool, tid),
        isFeedbackEnabled: (tid) => isWeeklyFeedbackEnabledForTenant(settingsRepo, tid),
        resolveBusinessName: (tid) => resolveTenantBusinessName(settingsRepo, tid),
        sendEmail: async (args) => {
          if (shouldFail) throw new Error('simulated transient send failure');
          sentEmails.push(args);
        },
        listTenantIds: async () => [tenantId],
        logger,
        now: () => NOW,
      });

    const resultIn1 = await runFor(tenantIn.tenantId, false);
    const resultOut1 = await runFor(tenantOut.tenantId, false);
    const resultFail1 = await runFor(tenantFail.tenantId, true);

    expect(resultIn1).toMatchObject({ sent: 1, failed: 0 });
    expect(resultOut1).toMatchObject({ sent: 0, failed: 0 }); // opted out — never even attempted
    expect(resultFail1).toMatchObject({ sent: 0, failed: 1 });

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('test@example.com');

    // Real audit ledger: tenantIn has exactly one sent row; tenantOut and
    // tenantFail have none (tenantFail's throw left no marker — "no row so
    // the week retries").
    const weekKey = WEEK_START.toISOString().slice(0, 10);
    const auditIn = await auditRepo.findByEntity(tenantIn.tenantId, 'weekly_feedback_email', weekKey);
    expect(auditIn.filter((e) => e.eventType === 'weekly_feedback_email.sent')).toHaveLength(1);
    const auditOut = await auditRepo.findByEntity(tenantOut.tenantId, 'weekly_feedback_email', weekKey);
    expect(auditOut).toHaveLength(0);
    const auditFail = await auditRepo.findByEntity(tenantFail.tenantId, 'weekly_feedback_email', weekKey);
    expect(auditFail).toHaveLength(0);

    // T2 isolation: tenantOut's audit context never sees tenantIn's sent row.
    const crossRead = await auditRepo.findByEntity(tenantOut.tenantId, 'weekly_feedback_email', weekKey);
    expect(crossRead.filter((e) => e.eventType === 'weekly_feedback_email.sent')).toHaveLength(0);

    // Idempotent ledger, real Postgres: re-running tenantIn sends nothing more.
    const resultIn2 = await runFor(tenantIn.tenantId, false);
    expect(resultIn2).toMatchObject({ sent: 0, failed: 0 });
    expect(sentEmails).toHaveLength(1); // unchanged

    // The week retries for the tenant whose send failed: this time it
    // succeeds and the ledger row now exists.
    const resultFail2 = await runFor(tenantFail.tenantId, false);
    expect(resultFail2).toMatchObject({ sent: 1, failed: 0 });
    const auditFail2 = await auditRepo.findByEntity(tenantFail.tenantId, 'weekly_feedback_email', weekKey);
    expect(auditFail2.filter((e) => e.eventType === 'weekly_feedback_email.sent')).toHaveLength(1);
  });
});
