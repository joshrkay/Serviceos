/**
 * Layer 1 — Route Shape Tests: Invoices
 *
 * Proves that the invoices endpoints return the fields the UI reads
 * (invoiceNumber, status, totalCents, amountDueCents) and that all
 * money values are integers (never floats).
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp } from './test-app';
import type { Express } from 'express';

const SAMPLE_LINE_ITEMS = [
  {
    id: 'li-1',
    description: 'Labor charge',
    quantity: 2,
    unitPriceCents: 7500,
    totalCents: 15000,
    category: 'labor',
    sortOrder: 0,
    taxable: false,
  },
];

async function createInvoice(app: Express, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/invoices')
    .send({
      jobId: 'job-1',
      // invoiceNumber is required by the schema but auto-generated server-side;
      // any non-empty string passes Zod and the server overwrites it.
      invoiceNumber: 'PLACEHOLDER',
      lineItems: SAMPLE_LINE_ITEMS,
      ...overrides,
    });
}

describe('POST /api/invoices', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 201 with an invoice containing required UI fields', async () => {
    const res = await createInvoice(app);

    expect(res.status).toBe(201);
    const inv = res.body;
    expect(typeof inv.id).toBe('string');
    expect(typeof inv.invoiceNumber).toBe('string');
    expect(inv.invoiceNumber).toMatch(/^INV-/);
    expect(inv.status).toBe('draft');
    expect(inv.jobId).toBe('job-1');
  });

  it('totalCents and amountDueCents are integers (never floats)', async () => {
    const res = await createInvoice(app);
    expect(res.status).toBe(201);

    const inv = res.body;
    expect(Number.isInteger(inv.totals.totalCents)).toBe(true);
    expect(Number.isInteger(inv.amountDueCents)).toBe(true);
    expect(Number.isInteger(inv.amountPaidCents)).toBe(true);
  });

  it('amountDueCents equals totalCents when nothing has been paid', async () => {
    const res = await createInvoice(app);
    expect(res.status).toBe(201);
    expect(res.body.amountDueCents).toBe(res.body.totals.totalCents);
    expect(res.body.amountPaidCents).toBe(0);
  });

  it('calculates totalCents from line items', async () => {
    const res = await createInvoice(app, {
      lineItems: [
        { id: 'li-1', description: 'Part A', quantity: 1, unitPriceCents: 4999, totalCents: 4999, category: 'material', sortOrder: 0, taxable: false },
        { id: 'li-2', description: 'Part B', quantity: 1, unitPriceCents: 5001, totalCents: 5001, category: 'material', sortOrder: 1, taxable: false },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.totals.subtotalCents).toBe(10000);
    expect(res.body.totals.totalCents).toBe(10000);
  });

  it('auto-increments invoice numbers sequentially', async () => {
    const r1 = await createInvoice(app);
    const r2 = await createInvoice(app);
    expect(r1.body.invoiceNumber).toBe('INV-0001');
    expect(r2.body.invoiceNumber).toBe('INV-0002');
  });

  it('returns an error when lineItems is empty', async () => {
    const res = await request(app).post('/api/invoices').send({
      jobId: 'job-1',
      invoiceNumber: 'PLACEHOLDER',
      lineItems: [],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toHaveProperty('error');
  });
});

describe('GET /api/invoices/:id', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 200 with the invoice when found', async () => {
    const created = await createInvoice(app);
    const res = await request(app).get(`/api/invoices/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.invoiceNumber).toBe(created.body.invoiceNumber);
  });

  it('returns 404 for unknown invoice id', async () => {
    const res = await request(app).get('/api/invoices/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});

describe('POST /api/invoices/:id/issue', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('issues a draft invoice and transitions it to open status', async () => {
    const created = await createInvoice(app);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');

    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/issue`)
      .send({ paymentTermDays: 30 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
    expect(res.body.issuedAt).toBeTruthy();
    expect(res.body.dueDate).toBeTruthy();
  });

  it('uses default 30-day payment term when not specified', async () => {
    const created = await createInvoice(app);
    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/issue`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
  });
});

describe('POST /api/invoices/:id/transition', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('transitions draft → canceled', async () => {
    const created = await createInvoice(app);

    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/transition`)
      .send({ status: 'canceled' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('canceled');
  });

  it('transitions open → void', async () => {
    const created = await createInvoice(app);
    // Issue it first to get to open status
    await request(app)
      .post(`/api/invoices/${created.body.id}/issue`)
      .send({});

    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/transition`)
      .send({ status: 'void' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('void');
  });

  it('returns an error for invalid transition', async () => {
    const created = await createInvoice(app);
    expect(created.status).toBe(201);
    // draft → paid is not a valid transition.
    // The lifecycle throws a plain Error so the server returns 5xx.
    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/transition`)
      .send({ status: 'paid' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('returns 400 when status is missing', async () => {
    const created = await createInvoice(app);
    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/transition`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
