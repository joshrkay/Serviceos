import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgTimeEntryRepository } from '../../src/time-tracking/pg-time-entry';
import { PgExpenseRepository } from '../../src/expenses/pg-expense';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { ensureTenantSettings, updateSettings } from '../../src/settings/settings';
import { getJobProfit } from '../../src/jobs/job-profit';
import { calculateDocumentTotals, buildLineItem } from '../../src/shared/billing-engine';
import type { Invoice, InvoiceStatus } from '../../src/invoices/invoice';

/**
 * P22-005 (U7) — per-job profit against REAL Postgres rows. A mocked-DB test is
 * not sufficient: this pins the actual time_entries / expenses / invoices
 * columns (and the migration-143 labor_rate_cents_per_hour column) the rollup
 * reads, and proves tenant isolation through RLS + the repos' tenant scoping.
 */
describe('Postgres integration — per-job profit (P22-005)', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let invoiceRepo: PgInvoiceRepository;
  let timeEntryRepo: PgTimeEntryRepository;
  let expenseRepo: PgExpenseRepository;
  let settingsRepo: PgSettingsRepository;

  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };
  let jobId: string;
  let otherTenantJobId: string;

  let invSeq = 0;

  async function seedTenantWorld(t: { tenantId: string; userId: string }): Promise<string> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Acme',
      lastName: 'Co',
      displayName: 'Acme Co',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '1 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jId = crypto.randomUUID();
    await jobRepo.create({
      id: jId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jId.slice(0, 4)}`,
      summary: 'Miller water heater',
      status: 'completed',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jId;
  }

  async function seedInvoice(
    t: { tenantId: string; userId: string },
    jId: string,
    totalCents: number,
    status: InvoiceStatus,
  ): Promise<void> {
    const lineItems = [buildLineItem(crypto.randomUUID(), 'work', 1, totalCents, 0, false)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const invoice: Invoice = {
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      jobId: jId,
      invoiceNumber: `INV-${++invSeq}`,
      status,
      lineItems,
      totals,
      amountPaidCents: status === 'paid' ? totals.totalCents : 0,
      amountDueCents: status === 'paid' ? 0 : totals.totalCents,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await invoiceRepo.create(invoice);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    timeEntryRepo = new PgTimeEntryRepository(pool);
    expenseRepo = new PgExpenseRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);

    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
    jobId = await seedTenantWorld(tenant);
    otherTenantJobId = await seedTenantWorld(other);

    // Tenant under test: labor rate $40/hr (4000 cents).
    await ensureTenantSettings(tenant.tenantId, settingsRepo);
    await updateSettings(tenant.tenantId, { laborRateCentsPerHour: 4000 }, settingsRepo);

    // Revenue for the job under test: $850 open + $300 paid; a draft is excluded.
    await seedInvoice(tenant, jobId, 85000, 'open');
    await seedInvoice(tenant, jobId, 30000, 'paid');
    await seedInvoice(tenant, jobId, 99900, 'draft');

    // Labor: a 3h job entry (counts) + 1h drive entry (does not).
    await timeEntryRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      jobId,
      entryType: 'job',
      clockedInAt: new Date('2026-06-01T09:00:00Z'),
      clockedOutAt: new Date('2026-06-01T12:00:00Z'),
      durationMinutes: 180,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await timeEntryRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      jobId,
      entryType: 'drive',
      clockedInAt: new Date('2026-06-01T08:00:00Z'),
      clockedOutAt: new Date('2026-06-01T09:00:00Z'),
      durationMinutes: 60,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Expenses: $200 + $120 job-scoped, plus a $500 expense on no job (excluded).
    for (const [amount, withJob] of [
      [20000, true],
      [12000, true],
      [50000, false],
    ] as const) {
      await expenseRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        ...(withJob ? { jobId } : {}),
        description: 'parts',
        amountCents: amount,
        category: 'materials',
        spentAt: new Date('2026-06-01T10:00:00Z'),
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Cross-tenant noise on the OTHER tenant's job — must never leak in.
    await seedInvoice(other, otherTenantJobId, 999999, 'paid');
    await expenseRepo.create({
      id: crypto.randomUUID(),
      tenantId: other.tenantId,
      jobId: otherTenantJobId,
      description: 'other parts',
      amountCents: 777777,
      category: 'materials',
      spentAt: new Date('2026-06-01T10:00:00Z'),
      createdBy: other.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await timeEntryRepo.create({
      id: crypto.randomUUID(),
      tenantId: other.tenantId,
      userId: other.userId,
      jobId: otherTenantJobId,
      entryType: 'job',
      clockedInAt: new Date('2026-06-01T09:00:00Z'),
      clockedOutAt: new Date('2026-06-01T18:00:00Z'),
      durationMinutes: 540,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('aggregates revenue, labor, and expenses correctly from real rows', async () => {
    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    expect(settings?.laborRateCentsPerHour).toBe(4000);

    const profit = await getJobProfit(
      {
        tenantId: tenant.tenantId,
        jobId,
        laborRateCentsPerHour: settings?.laborRateCentsPerHour ?? null,
      },
      { invoiceRepo, timeEntryRepo, expenseRepo },
    );

    // Revenue = 85000 (open) + 30000 (paid); draft excluded.
    expect(profit.revenueCents).toBe(115000);
    // Labor = 180 job minutes only (drive excluded) @ $40/hr = $120.
    expect(profit.laborMinutes).toBe(180);
    expect(profit.laborCents).toBe(12000);
    // Materials default to 0 (no job_parts table).
    expect(profit.materialsCents).toBe(0);
    // Expenses = 20000 + 12000 (the no-job $500 excluded).
    expect(profit.expensesCents).toBe(32000);
    // margin = 115000 − 12000 − 0 − 32000 = 71000.
    expect(profit.marginCents).toBe(71000);
    expect(profit.laborUnpriced).toBe(false);
    // 71000 / 115000 = 61.7%.
    expect(profit.marginPct).toBe(61.7);
  });

  it('isolates per-tenant: the other tenant only sees its own job rollup', async () => {
    const profit = await getJobProfit(
      { tenantId: other.tenantId, jobId: otherTenantJobId, laborRateCentsPerHour: null },
      { invoiceRepo, timeEntryRepo, expenseRepo },
    );
    expect(profit.revenueCents).toBe(999999);
    expect(profit.expensesCents).toBe(777777);
    expect(profit.laborMinutes).toBe(540);
    // No labor rate set for the other tenant ⇒ minutes-only.
    expect(profit.laborUnpriced).toBe(true);
    expect(profit.laborCents).toBeNull();
  });

  it("a tenant querying another tenant's jobId gets an empty rollup (RLS)", async () => {
    // Reading the OTHER tenant's job id under THIS tenant's scope returns
    // nothing — RLS + the explicit tenant predicate filter every row out.
    const profit = await getJobProfit(
      { tenantId: tenant.tenantId, jobId: otherTenantJobId, laborRateCentsPerHour: 4000 },
      { invoiceRepo, timeEntryRepo, expenseRepo },
    );
    expect(profit.revenueCents).toBe(0);
    expect(profit.expensesCents).toBe(0);
    expect(profit.laborMinutes).toBe(0);
    expect(profit.marginCents).toBe(0);
  });

  it('persists and reads back the migration-143 labor_rate_cents_per_hour column', async () => {
    // Pin the real column name end-to-end (write via update, read via mapRow).
    await updateSettings(tenant.tenantId, { laborRateCentsPerHour: 5500 }, settingsRepo);
    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    expect(settings?.laborRateCentsPerHour).toBe(5500);

    // Clearing to null is honored (unpriced).
    await updateSettings(tenant.tenantId, { laborRateCentsPerHour: null }, settingsRepo);
    const cleared = await settingsRepo.findByTenant(tenant.tenantId);
    expect(cleared?.laborRateCentsPerHour).toBeUndefined();
  });
});
