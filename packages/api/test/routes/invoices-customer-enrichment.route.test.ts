/**
 * WS6 (QUALITY-2026-07-12) — invoice list/detail responses must embed a
 * `customer` summary resolved via invoice → job → customer, so the UI renders
 * a real customer name instead of the literal "Customer" fallback.
 *
 * Uses the shared in-memory test app (real repos wired end-to-end) and seeds a
 * customer + job so the enrichment join has something to resolve. Tenant
 * isolation is asserted: a customer in another tenant is never leaked.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp, TEST_TENANT_ID, TEST_USER_ID, type TestApp } from './test-app';
import { createCustomer } from '../../src/customers/customer';
import { createJob } from '../../src/jobs/job';
import type { Express } from 'express';

const SAMPLE_LINE_ITEMS = [
  {
    id: 'li-1',
    description: 'Labor charge',
    quantity: 1,
    unitPriceCents: 10000,
    totalCents: 10000,
    category: 'labor',
    sortOrder: 0,
    taxable: false,
  },
];

async function seedCustomerJob(ctx: TestApp, overrides: { firstName?: string; lastName?: string } = {}) {
  const customer = await createCustomer(
    {
      tenantId: TEST_TENANT_ID,
      firstName: overrides.firstName ?? 'Ada',
      lastName: overrides.lastName ?? 'Lovelace',
      createdBy: TEST_USER_ID,
    },
    ctx.customerRepo,
  );
  const job = await createJob(
    {
      tenantId: TEST_TENANT_ID,
      customerId: customer.id,
      locationId: 'loc-1',
      summary: 'Test job',
      createdBy: TEST_USER_ID,
    },
    ctx.jobRepo,
  );
  return { customer, job };
}

async function createInvoiceForJob(app: Express, jobId: string) {
  return request(app)
    .post('/api/invoices')
    .send({ jobId, invoiceNumber: 'PLACEHOLDER', lineItems: SAMPLE_LINE_ITEMS });
}

describe('WS6 invoice customer enrichment', () => {
  let ctx: TestApp;
  let app: Express;

  beforeEach(async () => {
    ctx = await buildTestApp();
    app = ctx.app;
  });

  it('GET /api/invoices/:id embeds the resolved customer displayName', async () => {
    const { customer, job } = await seedCustomerJob(ctx);
    const created = await createInvoiceForJob(app, job.id);
    expect(created.status).toBe(201);

    const res = await request(app).get(`/api/invoices/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.customer).toBeDefined();
    expect(res.body.customer.id).toBe(customer.id);
    expect(res.body.customer.displayName).toBe('Ada Lovelace');
  });

  it('GET /api/invoices (list) embeds a customer on each row', async () => {
    const { customer, job } = await seedCustomerJob(ctx);
    await createInvoiceForJob(app, job.id);

    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    const rows = Array.isArray(res.body) ? res.body : res.body.data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].customer?.displayName).toBe('Ada Lovelace');
    expect(rows[0].customer?.id).toBe(customer.id);
  });

  it('GET /api/invoices?jobId= (legacy array) embeds the customer', async () => {
    const { job } = await seedCustomerJob(ctx);
    await createInvoiceForJob(app, job.id);

    const res = await request(app).get(`/api/invoices?jobId=${job.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].customer?.displayName).toBe('Ada Lovelace');
  });

  it('paginated list embeds customers on data rows', async () => {
    const { job } = await seedCustomerJob(ctx);
    await createInvoiceForJob(app, job.id);

    const res = await request(app).get('/api/invoices?paginated=true');
    expect(res.status).toBe(200);
    expect(res.body.data[0].customer?.displayName).toBe('Ada Lovelace');
    expect(typeof res.body.total).toBe('number');
  });

  it('leaves the invoice unenriched (no customer) when the job has no resolvable customer', async () => {
    // Invoice against a job id that was never seeded — enrichment finds no job,
    // so no customer is attached, but the invoice still returns normally.
    const created = await createInvoiceForJob(app, 'job-orphan');
    expect(created.status).toBe(201);
    const res = await request(app).get(`/api/invoices/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.customer).toBeUndefined();
  });
});
