/**
 * #1288 — the tenant DEFAULT tax rate at real Postgres.
 *
 *   - `tenant_settings.default_tax_rate_bps` (migration 289) round-trips through
 *     PgSettingsRepository, reads back by RAW SQL, and its CHECK rejects a rate
 *     above 100% (raw UPDATE, app validation bypassed).
 *   - The real estimate route, over real Pg settings + estimate repositories,
 *     stamps the tenant default onto an estimate created without `taxRateBps`
 *     — read back from `estimates.tax_rate_bps` / `tax_cents` by raw SQL.
 *   - T1: a neighbour tenant with no default gets 0, never the other's rate.
 *
 * Run:
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.mts test/integration/tenant-default-tax-rate.test.ts
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { createEstimateRouter } from '../../src/routes/estimates';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { TenantOwnership } from '../../src/shared/tenant-ownership';

describe('Postgres integration — #1288 tenant default tax rate', () => {
  let pool: Pool;
  let settingsRepo: PgSettingsRepository;
  let app: express.Express;
  let acting: TestTenant;
  let taxed: TestTenant;
  let untaxed: TestTenant;

  async function seedSettings(t: TestTenant) {
    const now = new Date();
    await settingsRepo.create({
      id: randomUUID(),
      tenantId: t.tenantId,
      businessName: 'Tax Co',
      timezone: 'America/Phoenix',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function seedJob(t: TestTenant): Promise<string> {
    const customerId = randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Tax',
      lastName: 'Payer',
      displayName: 'Tax Payer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '1 Levy Way',
      city: 'Phoenix',
      state: 'AZ',
      postalCode: '85001',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: '#1288 default tax proof',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    taxed = await createTestTenant(pool);
    untaxed = await createTestTenant(pool);
    await seedSettings(taxed);
    await seedSettings(untaxed);
    acting = taxed;

    const ownership: TenantOwnership = {
      requireExists: async () => undefined,
    } as unknown as TenantOwnership;

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: acting.userId,
        sessionId: `sess_${acting.userId}`,
        tenantId: acting.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/estimates',
      createEstimateRouter(
        new PgEstimateRepository(pool),
        settingsRepo,
        new PgAuditRepository(pool),
        ownership,
      ),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('default_tax_rate_bps round-trips through the repo and reads back by raw SQL', async () => {
    const updated = await settingsRepo.update(taxed.tenantId, { defaultTaxRateBps: 825 });
    expect(updated!.defaultTaxRateBps).toBe(825);
    expect((await settingsRepo.findByTenant(taxed.tenantId))!.defaultTaxRateBps).toBe(825);

    const { rows } = await pool.query<{ default_tax_rate_bps: number }>(
      `SELECT default_tax_rate_bps FROM tenant_settings WHERE tenant_id = $1`,
      [taxed.tenantId],
    );
    expect(rows[0].default_tax_rate_bps).toBe(825);

    // A fresh row defaults to 0 — never a guessed rate.
    expect((await settingsRepo.findByTenant(untaxed.tenantId))!.defaultTaxRateBps).toBe(0);
  });

  it('DB CHECK rejects a default above 100% (raw UPDATE)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant_id = '${taxed.tenantId}'`);
      await expect(
        client.query(
          `UPDATE tenant_settings SET default_tax_rate_bps = 10001 WHERE tenant_id = $1`,
          [taxed.tenantId],
        ),
      ).rejects.toMatchObject({ code: '23514' }); // check_violation, not a missing column
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the real estimate route stamps the tenant default; the neighbour keeps 0 (T1)', async () => {
    await settingsRepo.update(taxed.tenantId, { defaultTaxRateBps: 825 });

    acting = taxed;
    const jobA = await seedJob(taxed);
    const a = await request(app)
      .post('/api/estimates')
      .send({
        jobId: jobA,
        estimateNumber: 'PLACEHOLDER',
        lineItems: [
          {
            id: randomUUID(),
            description: 'Water heater',
            quantity: 1,
            unitPriceCents: 10000,
            totalCents: 10000,
            category: 'material',
            sortOrder: 0,
            taxable: true,
          },
        ],
      });
    expect(a.status).toBe(201);

    acting = untaxed;
    const jobB = await seedJob(untaxed);
    const b = await request(app)
      .post('/api/estimates')
      .send({
        jobId: jobB,
        estimateNumber: 'PLACEHOLDER',
        lineItems: [
          {
            id: randomUUID(),
            description: 'Water heater',
            quantity: 1,
            unitPriceCents: 10000,
            totalCents: 10000,
            category: 'material',
            sortOrder: 0,
            taxable: true,
          },
        ],
      });
    expect(b.status).toBe(201);

    const { rows } = await pool.query<{
      id: string;
      tenant_id: string;
      tax_rate_bps: number;
      tax_cents: number;
      total_cents: number;
    }>(
      `SELECT id, tenant_id, tax_rate_bps, tax_cents, total_cents FROM estimates WHERE id = ANY($1)`,
      [[a.body.id, b.body.id]],
    );
    const rowA = rows.find((r) => r.id === a.body.id)!;
    const rowB = rows.find((r) => r.id === b.body.id)!;
    expect(rowA.tenant_id).toBe(taxed.tenantId);
    expect(rowA.tax_rate_bps).toBe(825);
    expect(rowA.tax_cents).toBe(825);
    expect(rowA.total_cents).toBe(10825);
    expect(rowB.tenant_id).toBe(untaxed.tenantId);
    expect(rowB.tax_rate_bps).toBe(0);
    expect(rowB.tax_cents).toBe(0);
    expect(rowB.total_cents).toBe(10000);
  });
});
