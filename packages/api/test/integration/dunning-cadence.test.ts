/**
 * §8.9 Collections cadence — the reminder cadence against REAL Postgres.
 *
 * What was missing (ticket #1023, G1 from the §8.8 entry audit on #1009): the
 * only real-DB dunning test (payment-reminder-dedup.test.ts) keys on
 * `manual:<proposalId>`. The CADENCE key — `'3:sms' | '7:sms' | '14:sms'`,
 * produced by `reminderStepKey` and written by the overdue sweep — had never
 * met the real `UNIQUE (tenant_id, invoice_id, kind, step_key)` index on
 * `invoice_dunning_events`. Every duplicate-send proof ran against
 * `InMemoryDunningEventRepository`, which HAND-CODES the 23505
 * (invoices/dunning-config.ts:187-197) — so "a duplicate send is impossible"
 * was a claim about a test double, not about the database.
 *
 * This file drives `runOverdueInvoiceSweep` (workers/overdue-invoice-worker.ts)
 * with the production Pg repositories and asserts:
 *   1. the cadence steps land as real rows under their cadence step keys;
 *   2. a second attempt at the SAME cadence key is rejected by the INDEX —
 *      proven with a raw SQL INSERT that touches no application code at all;
 *   3. a re-sweep raises no second proposal for a step already recorded;
 *   4. the sweep's audit trail reads back through `PgAuditRepository.findByEntity`;
 *   5. T1 — a second tenant's OWN cadence is honoured in the same pass and
 *      neither tenant can see the other's ledger rows.
 *
 * Runs only under the integration harness (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import {
  PgDunningConfigRepository,
  PgDunningEventRepository,
} from '../../src/invoices/pg-dunning-config';
import { defaultDunningConfig, ReminderStep } from '../../src/invoices/dunning-config';
import { runOverdueInvoiceSweep } from '../../src/workers/overdue-invoice-worker';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const DAY_MS = 24 * 60 * 60 * 1000;

interface SeededInvoice {
  tenantId: string;
  userId: string;
  invoiceId: string;
  jobId: string;
}

describe('Postgres integration — dunning cadence at the real UNIQUE index (§8.9)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let jobRepo: PgJobRepository;
  let estimateRepo: PgEstimateRepository;
  let auditRepo: PgAuditRepository;
  let proposalRepo: PgProposalRepository;
  let dunningEventRepo: PgDunningEventRepository;
  let dunningConfigRepo: PgDunningConfigRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;

  /** An overdue OPEN invoice on its own tenant, due `daysOverdue` days ago. */
  async function seedOverdueInvoice(
    daysOverdue: number,
    now: Date,
    amountCents = 50_000,
  ): Promise<SeededInvoice> {
    const { tenantId, userId } = await createTestTenant(pool);
    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Dun',
      lastName: 'Ning',
      displayName: 'Dun Ning',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = uuidv4();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1 Overdue Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: `J-${jobId.slice(0, 8)}`,
      summary: 'Overdue cadence job',
      status: 'completed',
      priority: 'normal',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const invoiceId = uuidv4();
    const lineItems = [buildLineItem(uuidv4(), 'Labor', 1, amountCents, 0, false, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId,
      jobId,
      invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      dueDate: new Date(now.getTime() - daysOverdue * DAY_MS),
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { tenantId, userId, invoiceId, jobId };
  }

  /** Persist an explicit cadence for a tenant (real `invoice_dunning_configs` row). */
  async function seedCadence(tenantId: string, steps: ReminderStep[]): Promise<void> {
    await dunningConfigRepo.upsert({
      ...defaultDunningConfig(tenantId),
      reminderSteps: steps,
    });
  }

  const sweepFor = (tenantIds: string[], now: Date) =>
    runOverdueInvoiceSweep({
      jobRepo,
      estimateRepo,
      invoiceRepo,
      auditRepo,
      proposalRepo,
      dunningEventRepo,
      dunningConfigRepo,
      listTenantIds: async () => tenantIds,
      now: () => now,
      logger,
    });

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    jobRepo = new PgJobRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    dunningEventRepo = new PgDunningEventRepository(pool);
    dunningConfigRepo = new PgDunningConfigRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('writes the cadence step keys 3:sms / 7:sms / 14:sms as real ledger rows, and audits each proposal', async () => {
    const now = new Date('2026-03-20T12:00:00.000Z');
    // 15 days past due, swept TWICE — the §8.9 acceptance criterion verbatim.
    // (An earlier revision seeded 20 days and swept once, which left the
    // criterion's boundary untested: at 20 days the 14-day step has six days
    // of slack, so a regression delaying it to day 16+ would still have passed.
    // Review finding, PR #1053.)
    const seeded = await seedOverdueInvoice(15, now);
    await seedCadence(seeded.tenantId, [
      { offsetDays: 3, channel: 'sms' },
      { offsetDays: 7, channel: 'sms' },
      { offsetDays: 14, channel: 'sms' },
    ]);

    await sweepFor([seeded.tenantId], now);
    await sweepFor([seeded.tenantId], now);

    const events = await dunningEventRepo.findByInvoice(seeded.tenantId, seeded.invoiceId);
    expect(events.map((e) => e.stepKey).sort()).toEqual(['14:sms', '3:sms', '7:sms']);
    expect(events.every((e) => e.kind === 'reminder')).toBe(true);
    expect(events.every((e) => e.channel === 'sms')).toBe(true);

    // The rows are really in Postgres under those keys (not just in a mapper).
    const { rows } = await pool.query<{ step_key: string }>(
      `SELECT step_key FROM invoice_dunning_events
       WHERE tenant_id = $1 AND invoice_id = $2 AND kind = 'reminder'
       ORDER BY step_key`,
      [seeded.tenantId, seeded.invoiceId],
    );
    expect(rows.map((r) => r.step_key)).toEqual(['14:sms', '3:sms', '7:sms']);

    // Audit read-back through the production repository (not an in-memory one).
    const audits = await auditRepo.findByEntity(seeded.tenantId, 'invoice', seeded.invoiceId);
    const proposedKeys = audits
      .filter((a) => a.eventType === 'invoice.dunning_proposed')
      .map((a) => (a.metadata as { stepKey?: string }).stepKey)
      .sort();
    expect(proposedKeys).toEqual(['14:sms', '3:sms', '7:sms']);
    expect(audits.map((a) => a.eventType)).toContain('invoice.overdue');

    // One owner-approval proposal per due step — nothing auto-sends.
    const proposals = await proposalRepo.findByStatus(seeded.tenantId, 'ready_for_review');
    const reminders = proposals.filter((p) => p.proposalType === 'send_payment_reminder');
    expect(reminders).toHaveLength(3);
  });

  it('fires each step ON its offset day and not before — the 13/14-day boundary', async () => {
    const now = new Date('2026-03-25T12:00:00.000Z');
    const steps = [
      { offsetDays: 3, channel: 'sms' as const },
      { offsetDays: 7, channel: 'sms' as const },
      { offsetDays: 14, channel: 'sms' as const },
    ];

    // One day SHORT of the 14-day step: it must not fire yet.
    const dayThirteen = await seedOverdueInvoice(13, now);
    await seedCadence(dayThirteen.tenantId, steps);
    await sweepFor([dayThirteen.tenantId], now);
    expect(
      (await dunningEventRepo.findByInvoice(dayThirteen.tenantId, dayThirteen.invoiceId))
        .map((e) => e.stepKey)
        .sort(),
    ).toEqual(['3:sms', '7:sms']);

    // Exactly ON the offset day: it must fire. Together these pin the
    // comparison in selectDueReminderSteps (dunning-schedule.ts:56,
    // `elapsed < step.offsetDays`) against an off-by-one in either direction.
    const dayFourteen = await seedOverdueInvoice(14, now);
    await seedCadence(dayFourteen.tenantId, steps);
    await sweepFor([dayFourteen.tenantId], now);
    expect(
      (await dunningEventRepo.findByInvoice(dayFourteen.tenantId, dayFourteen.invoiceId))
        .map((e) => e.stepKey)
        .sort(),
    ).toEqual(['14:sms', '3:sms', '7:sms']);
  });

  it('rejects a duplicate cadence key at the INDEX — a raw INSERT that runs no application code', async () => {
    const now = new Date('2026-04-10T12:00:00.000Z');
    const seeded = await seedOverdueInvoice(10, now);
    await seedCadence(seeded.tenantId, [{ offsetDays: 3, channel: 'sms' }]);

    await sweepFor([seeded.tenantId], now);
    const before = await dunningEventRepo.findByInvoice(seeded.tenantId, seeded.invoiceId);
    expect(before.map((e) => e.stepKey)).toEqual(['3:sms']);

    // The second send attempt for the SAME cadence key. This is raw SQL: no
    // repository, no worker, no in-memory guard — if the row lands, a duplicate
    // reminder is possible in production. It must be the database that refuses.
    //
    // The tenant GUC is set with `set_config(..., true)` inside an explicit
    // transaction: a bare `SET LOCAL` outside a transaction block is DISCARDED
    // by Postgres with the warning "SET LOCAL can only be used in transaction
    // blocks", which would leave the insert running with no tenant context at
    // all (review finding, PR #1053).
    const client = await pool.connect();
    let code: string | undefined;
    let constraint: string | undefined;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
        seeded.tenantId,
      ]);
      await client.query(
        `INSERT INTO invoice_dunning_events
           (id, tenant_id, invoice_id, kind, step_key, channel, sent_at)
         VALUES ($1, $2, $3, 'reminder', '3:sms', 'sms', NOW())`,
        [uuidv4(), seeded.tenantId, seeded.invoiceId],
      );
      await client.query('COMMIT');
    } catch (err) {
      code = (err as { code?: string }).code;
      constraint = (err as { constraint?: string }).constraint;
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(code).toBe('23505');
    expect(constraint).toContain('step_key');

    // And the ledger still holds exactly one row for that step.
    const after = await dunningEventRepo.findByInvoice(seeded.tenantId, seeded.invoiceId);
    expect(after.filter((e) => e.stepKey === '3:sms')).toHaveLength(1);
  });

  it('re-sweeping the same overdue invoice raises no second reminder for an already-recorded step', async () => {
    const now = new Date('2026-05-01T12:00:00.000Z');
    const seeded = await seedOverdueInvoice(9, now);
    await seedCadence(seeded.tenantId, [
      { offsetDays: 3, channel: 'sms' },
      { offsetDays: 7, channel: 'sms' },
      { offsetDays: 14, channel: 'sms' },
    ]);

    await sweepFor([seeded.tenantId], now);
    await sweepFor([seeded.tenantId], now);
    await sweepFor([seeded.tenantId], now);

    const events = await dunningEventRepo.findByInvoice(seeded.tenantId, seeded.invoiceId);
    // 9 days past due → 3 and 7 are due, 14 is not. Three sweeps, still two rows.
    expect(events.map((e) => e.stepKey).sort()).toEqual(['3:sms', '7:sms']);

    const proposals = await proposalRepo.findByStatus(seeded.tenantId, 'ready_for_review');
    expect(proposals.filter((p) => p.proposalType === 'send_payment_reminder')).toHaveLength(2);
  });

  it('T1 — each tenant is chased on its OWN cadence in one pass, and neither can read the other ledger', async () => {
    const now = new Date('2026-06-05T12:00:00.000Z');
    const tenantA = await seedOverdueInvoice(20, now);
    const tenantB = await seedOverdueInvoice(20, now);
    await seedCadence(tenantA.tenantId, [
      { offsetDays: 3, channel: 'sms' },
      { offsetDays: 14, channel: 'sms' },
    ]);
    await seedCadence(tenantB.tenantId, [{ offsetDays: 5, channel: 'email' }]);

    await sweepFor([tenantA.tenantId, tenantB.tenantId], now);

    const aEvents = await dunningEventRepo.findByInvoice(tenantA.tenantId, tenantA.invoiceId);
    const bEvents = await dunningEventRepo.findByInvoice(tenantB.tenantId, tenantB.invoiceId);
    expect(aEvents.map((e) => e.stepKey).sort()).toEqual(['14:sms', '3:sms']);
    expect(bEvents.map((e) => e.stepKey)).toEqual(['5:email']);
    expect(bEvents[0].channel).toBe('email');

    // Cross-tenant: the other tenant's invoice ledger is not readable from here.
    const crossTenant = await dunningEventRepo.findByInvoice(
      tenantB.tenantId,
      tenantA.invoiceId,
    );
    expect(crossTenant).toEqual([]);

    // And each tenant's proposals stay in its own queue.
    const bProposals = await proposalRepo.findByStatus(tenantB.tenantId, 'ready_for_review');
    expect(
      bProposals.filter((p) => p.proposalType === 'send_payment_reminder'),
    ).toHaveLength(1);
  });
});
