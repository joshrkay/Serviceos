/**
 * Postgres integration — reports endpoints (routes/reports.ts).
 *
 * The QA-matrix Playwright spec (e2e/qa-matrix/reports.spec.ts) pins the
 * HTTP happy path (200 / 503 shapes) but cannot prove the aggregation SQL
 * — joins, window filters, RLS scoping, tenant-tz month boundaries — is
 * correct, because it has no fixtures it can rely on.  These tests drive
 * the underlying Pg repositories directly against real Postgres so the
 * SQL the route returns is pinned end-to-end.
 *
 * Scope: revenue-by-source aggregation correctness, money-dashboard
 * tenant-tz month boundary, and cross-tenant RLS leak guard.  /job-profit
 * is already covered by job-profit.int.test.ts; /tax-export and /hfcr are
 * follow-ups in the same gap list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgRevenueBySourceRepository } from '../../src/reports/revenue-by-source';
import { PgMoneyDashboardRepository } from '../../src/reports/pg-money-dashboard';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgExpenseRepository } from '../../src/expenses/pg-expense';

interface SeedWorld {
  customerId: string;
  jobId: string;
  invoiceId: string;
}

/**
 * Unprivileged role + GUC pattern mirrored from rls-tenant-isolation.test.ts.
 * `PgRevenueBySourceRepository.query` runs under withTenant and filters its
 * CTE with `WHERE i.tenant_id = $1`, so an isolation assertion that goes
 * through the repo (or runs as the testcontainer superuser) cannot
 * distinguish working RLS from normal SQL filtering. Querying through
 * asTenant under this NOBYPASSRLS role without a tenant_id predicate makes
 * the policy itself the only thing gating cross-tenant reads.
 */
const APP_ROLE = 'rls_app_runtime';

async function ensureRlsAppRole(pool: Pool): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
}

async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Postgres integration — reports endpoints', () => {
  let pool: Pool;
  let revenueRepo: PgRevenueBySourceRepository;
  let dashboardRepo: PgMoneyDashboardRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    revenueRepo = new PgRevenueBySourceRepository(pool);
    const invoiceRepo = new PgInvoiceRepository(pool);
    const paymentRepo = new PgPaymentRepository(pool);
    const expenseRepo = new PgExpenseRepository(pool);
    dashboardRepo = new PgMoneyDashboardRepository(invoiceRepo, paymentRepo, expenseRepo);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
    await ensureRlsAppRole(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  // ─── Fixture helpers (raw SQL keeps the seeding tight and matches the
  //     pattern in thank-you-sms-worker.test.ts / leads.test.ts) ─────────
  async function seedLead(
    t: { tenantId: string; userId: string },
    opts: { source: string; utmSource?: string; utmCampaign?: string },
  ): Promise<string> {
    const leadId = uuidv4();
    await pool.query(
      `INSERT INTO leads (id, tenant_id, first_name, last_name, source, stage,
        utm_source, utm_campaign, created_by)
       VALUES ($1,$2,$3,$4,$5,'new',$6,$7,$8)`,
      [leadId, t.tenantId, 'Lead', 'Person', opts.source,
       opts.utmSource ?? null, opts.utmCampaign ?? null, t.userId],
    );
    return leadId;
  }

  async function seedWorld(
    t: { tenantId: string; userId: string },
    opts: { leadId?: string; totalCents: number; invoiceNumber: string },
  ): Promise<SeedWorld> {
    const customerId = uuidv4();
    await pool.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name,
        preferred_channel, sms_consent, is_archived, originating_lead_id, created_by)
       VALUES ($1,$2,$3,$4,$5,'sms',true,false,$6,$7)`,
      [customerId, t.tenantId, 'Cust', 'Omer', 'Cust Omer', opts.leadId ?? null, t.userId],
    );

    const locationId = uuidv4();
    await pool.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, country)
       VALUES ($1,$2,$3,'1 Main','Phoenix','AZ','85001','US')`,
      [locationId, t.tenantId, customerId],
    );

    const jobId = uuidv4();
    await pool.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary,
        status, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,'job','completed','normal',$6)`,
      [jobId, t.tenantId, customerId, locationId, `JOB-${jobId.slice(0, 8)}`, t.userId],
    );

    const invoiceId = uuidv4();
    await pool.query(
      `INSERT INTO invoices (id, tenant_id, job_id, invoice_number, status,
        subtotal_cents, total_cents, amount_paid_cents, amount_due_cents,
        originating_lead_id, created_by, issued_at)
       VALUES ($1,$2,$3,$4,'open',$5,$5,0,$5,$6,$7, NOW())`,
      [invoiceId, t.tenantId, jobId, opts.invoiceNumber,
       opts.totalCents, opts.leadId ?? null, t.userId],
    );
    return { customerId, jobId, invoiceId };
  }

  async function seedPayment(
    t: { tenantId: string; userId: string },
    opts: { invoiceId: string; amountCents: number; status?: string; paidAt?: Date },
  ): Promise<string> {
    const paymentId = uuidv4();
    await pool.query(
      `INSERT INTO payments (id, tenant_id, invoice_id, amount_cents, status,
        payment_method, paid_at, created_by)
       VALUES ($1,$2,$3,$4,$5,'cash',$6,$7)`,
      [paymentId, t.tenantId, opts.invoiceId, opts.amountCents,
       opts.status ?? 'completed', opts.paidAt ?? new Date(), t.userId],
    );
    return paymentId;
  }

  // ─── /revenue-by-source ───────────────────────────────────────────────

  it('revenue-by-source aggregates attributed + unattributed revenue per source', async () => {
    // Attributed: lead source=web_form, utm_campaign=spring → $300 paid.
    const leadId = await seedLead(tenant, { source: 'web_form', utmCampaign: 'spring' });
    const attributed = await seedWorld(tenant, {
      leadId,
      totalCents: 30_000,
      invoiceNumber: `INV-${uuidv4().slice(0, 8)}`,
    });
    await seedPayment(tenant, { invoiceId: attributed.invoiceId, amountCents: 30_000 });

    // Unattributed: no lead → bucketed under source='unknown'.
    const unattributed = await seedWorld(tenant, {
      totalCents: 12_500,
      invoiceNumber: `INV-${uuidv4().slice(0, 8)}`,
    });
    await seedPayment(tenant, { invoiceId: unattributed.invoiceId, amountCents: 12_500 });

    const rows = await revenueRepo.query(tenant.tenantId, {});

    const bySource = new Map(rows.map((r) => [r.source, r] as const));
    const webForm = bySource.get('web_form');
    expect(webForm).toBeDefined();
    expect(webForm!.paidCents).toBe(30_000);
    expect(webForm!.invoicedCents).toBe(30_000);
    expect(webForm!.leadCount).toBe(1);
    expect(webForm!.customerCount).toBe(1);
    expect(webForm!.utmCampaign).toBe('spring');

    const unknown = bySource.get('unknown');
    expect(unknown).toBeDefined();
    expect(unknown!.paidCents).toBe(12_500);
    expect(unknown!.invoicedCents).toBe(12_500);
  });

  it('revenue-by-source does not leak revenue across tenants (RLS guard)', async () => {
    // Seed a fully-paid invoice on `other` only — a high-value sentinel
    // we can spot if it leaks into tenant's view.
    const otherWorld = await seedWorld(other, {
      totalCents: 99_999_00,
      invoiceNumber: `INV-${uuidv4().slice(0, 8)}`,
    });
    await seedPayment(other, { invoiceId: otherWorld.invoiceId, amountCents: 99_999_00 });

    // Seed a small local invoice on `tenant` so this test's RLS guard
    // doesn't pass vacuously when run in isolation (i.e. when the prior
    // test's `tenant` fixtures aren't already present in the shared DB).
    const tenantWorld = await seedWorld(tenant, {
      totalCents: 10_00,
      invoiceNumber: `INV-${uuidv4().slice(0, 8)}`,
    });
    await seedPayment(tenant, { invoiceId: tenantWorld.invoiceId, amountCents: 10_00 });

    // RLS proof: under tenant's GUC and the unprivileged role, enumerate
    // the underlying invoices/payments tables WITHOUT a tenant_id
    // predicate. Only the policies on those tables can gate this read
    // — if either were dropped, the sentinel 99_999_00 row would appear.
    const visibleInvoiceTotals = await asTenant(pool, tenant.tenantId, (client) =>
      client.query(
        `SELECT total_cents FROM invoices`,
      ).then((r) => r.rows.map((row: { total_cents: string | number }) => Number(row.total_cents))),
    );
    const visiblePaymentAmounts = await asTenant(pool, tenant.tenantId, (client) =>
      client.query(
        `SELECT amount_cents FROM payments`,
      ).then((r) => r.rows.map((row: { amount_cents: string | number }) => Number(row.amount_cents))),
    );
    // Tenant sees its own seed.
    expect(visibleInvoiceTotals).toContain(10_00);
    expect(visiblePaymentAmounts).toContain(10_00);
    // But NOT the sibling tenant's high-value sentinel — only the RLS
    // policies on invoices/payments can be enforcing this.
    expect(visibleInvoiceTotals).not.toContain(99_999_00);
    expect(visiblePaymentAmounts).not.toContain(99_999_00);
  });

  // ─── /money-dashboard ────────────────────────────────────────────────

  it('money-dashboard buckets a late-month tenant-local payment in the correct month', async () => {
    // 2026-05-31 23:30 America/New_York is 2026-06-01 03:30Z. Without
    // tenant-tz bucketing the dashboard would lose this $456 from May.
    const world = await seedWorld(tenant, {
      totalCents: 456_00,
      invoiceNumber: `INV-${uuidv4().slice(0, 8)}`,
    });
    await seedPayment(tenant, {
      invoiceId: world.invoiceId,
      amountCents: 456_00,
      // Wall clock 2026-05-31T23:30:00 in NY (EDT, UTC-4).
      paidAt: new Date('2026-06-01T03:30:00.000Z'),
    });

    // `now` is sometime in June so the report knows May is a closed month.
    const mayNY = await dashboardRepo.query(
      tenant.tenantId,
      '2026-05',
      new Date('2026-06-15T12:00:00.000Z'),
      'America/New_York',
    );
    // The May bucket contains at least the seeded $456 (NET revenue,
    // i.e. completed payments minus refunds, for this tenant in May).
    expect(mayNY.revenueCents).toBeGreaterThanOrEqual(456_00);

    // Prove the timezone boundary is real by querying the SAME June month
    // in TWO different timezones. In UTC the 03:30Z payment is in June; in
    // America/New_York it is in May. So:
    //
    //   juneUTC.revenueCents - juneNY.revenueCents == $456 (the seeded payment)
    //
    // A determinism-only check (`juneAfter == juneBefore` with same tz) would
    // pass even if the dashboard were silently bucketing this payment into
    // June for the NY tenant, because BOTH calls would include it. The
    // UTC-vs-NY delta is the assertion that catches a regression.
    const juneNY = await dashboardRepo.query(
      tenant.tenantId,
      '2026-06',
      new Date('2026-07-15T12:00:00.000Z'),
      'America/New_York',
    );
    const juneUTC = await dashboardRepo.query(
      tenant.tenantId,
      '2026-06',
      new Date('2026-07-15T12:00:00.000Z'),
      'UTC',
    );
    expect(juneUTC.revenueCents - juneNY.revenueCents).toBe(456_00);
  });
});
