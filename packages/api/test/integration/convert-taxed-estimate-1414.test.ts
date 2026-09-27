/**
 * #1414 — converting a TAXED, DISCOUNTED estimate to an invoice keeps its
 * tax rate and discount.
 *
 * Every step goes through the real HTTP routes of `createApp()` on real
 * Postgres: the estimate is created by `POST /api/estimates` (8.25% tax, a
 * $200 discount), accepted by `POST /api/estimates/:id/transition`, converted
 * by `POST /api/estimates/:id/convert-to-invoice` (the call the web
 * ConvertToInvoiceSheet makes) and read back by `GET /api/invoices/:id`.
 *
 * Worked example (independent of the engine): one taxable $1,200.00 line,
 * $200.00 discount → taxable base $1,000.00; 8.25% of that = $82.50;
 * total = $1,200.00 − $200.00 + $82.50 = $1,082.50.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant } from './shared';
import type { AppWithLifecycle } from '../../src/app';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

function bearer(sub: string): string {
  return `Bearer ${unsignedJwt({ sub, sid: `sess-${sub}`, role: 'owner', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
}

describe('#1414 — convert a taxed estimate to an invoice (real routes, real Postgres)', () => {
  let pool: Pool;
  let app: AppWithLifecycle;
  let server: Server;
  let baseUrl: string;
  let prevEnv: Record<string, string | undefined>;

  /** #1133 — the request transaction commits on res.finish; poll until visible. */
  async function waitFor(sql: string, params: unknown[]): Promise<void> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const { rowCount } = await pool.query(sql, params);
      if ((rowCount ?? 0) > 0 || Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function seedJob(): Promise<{ userId: string; jobId: string }> {
    const { tenantId, userId } = await createTestTenant(pool);
    const now = new Date();
    await new PgSettingsRepository(pool).create({
      id: crypto.randomUUID(),
      tenantId,
      businessName: 'Tax Carry Plumbing',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
    const customerId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: customerId,
      tenantId,
      firstName: 'Tess',
      lastName: 'Carry',
      displayName: 'Tess Carry',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1414 Tax Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
    const jobId = crypto.randomUUID();
    await new PgJobRepository(pool).create({
      id: jobId,
      tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-1414',
      summary: 'Repipe',
      status: 'in_progress',
      priority: 'normal',
      depositRequiredCents: 0,
      depositPaidCents: 0,
      depositStatus: 'not_required',
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    return { userId, jobId };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    prevEnv = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
      DATABASE_URL: process.env.DATABASE_URL,
      DB_SSL: process.env.DB_SSL,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    process.env.DATABASE_URL = process.env.TEST_DB_URL;
    process.env.DB_SSL = 'false';
    const { resetConfig } = await import('../../src/shared/config');
    const { createApp } = await import('../../src/app');
    resetConfig();
    app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.gracefulDrain('test-cleanup');
    const { resetConfig } = await import('../../src/shared/config');
    resetConfig();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeSharedTestDb();
  });

  it('the invoice carries the estimate’s 8.25% tax and $200 discount: $1,082.50', async () => {
    const { userId, jobId } = await seedJob();
    const auth = bearer(userId);

    const created = await request(baseUrl)
      .post('/api/estimates')
      .set('Authorization', auth)
      .send({
        jobId,
        discountCents: 20000,
        taxRateBps: 825,
        lineItems: [
          {
            id: crypto.randomUUID(),
            description: 'Repipe kitchen',
            quantity: 1,
            unitPriceCents: 120000,
            totalCents: 120000,
            category: 'labor',
            sortOrder: 0,
            taxable: true,
          },
        ],
      });
    expect(created.status).toBe(201);
    const estimateId = created.body.id as string;
    await waitFor('SELECT 1 FROM estimates WHERE id = $1', [estimateId]);

    const sent = await request(baseUrl)
      .post(`/api/estimates/${estimateId}/transition`)
      .set('Authorization', auth)
      .send({ status: 'sent' });
    expect(sent.status).toBe(200);
    await waitFor(`SELECT 1 FROM estimates WHERE id = $1 AND status = 'sent'`, [estimateId]);

    const accepted = await request(baseUrl)
      .post(`/api/estimates/${estimateId}/transition`)
      .set('Authorization', auth)
      .send({ status: 'accepted' });
    expect(accepted.status).toBe(200);
    await waitFor(`SELECT 1 FROM estimates WHERE id = $1 AND status = 'accepted'`, [estimateId]);

    const converted = await request(baseUrl)
      .post(`/api/estimates/${estimateId}/convert-to-invoice`)
      .set('Authorization', auth)
      .send({});
    expect(converted.status).toBe(201);
    await waitFor('SELECT 1 FROM invoices WHERE id = $1', [converted.body.id]);

    const invoice = await request(baseUrl)
      .get(`/api/invoices/${converted.body.id}`)
      .set('Authorization', auth);
    expect(invoice.status).toBe(200);
    expect(invoice.body.totals).toMatchObject({
      subtotalCents: 120000,
      discountCents: 20000,
      taxRateBps: 825,
      taxCents: 8250,
      totalCents: 108250,
    });
  });
});
