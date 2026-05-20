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

  it('returns 400 with field errors when lineItems is empty', async () => {
    const res = await request(app).post('/api/invoices').send({
      jobId: 'job-1',
      invoiceNumber: 'PLACEHOLDER',
      lineItems: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details.fields).toHaveProperty('lineItems');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/api/invoices').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details.fields).toHaveProperty('jobId');
  });
});

describe('PATCH /api/invoices/:id', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('updates a draft invoice and recalculates totals', async () => {
    const created = await createInvoice(app);
    const res = await request(app)
      .patch(`/api/invoices/${created.body.id}`)
      .send({
        lineItems: [
          { id: 'li-1', description: 'Updated', quantity: 1, unitPriceCents: 25000, totalCents: 25000, category: 'labor', sortOrder: 0, taxable: false },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.totals.totalCents).toBe(25000);
    expect(res.body.amountDueCents).toBe(25000);
  });

  it('returns 400 when editing an invoice that has been issued', async () => {
    const created = await createInvoice(app);
    await request(app).post(`/api/invoices/${created.body.id}/issue`).send({});

    const res = await request(app)
      .patch(`/api/invoices/${created.body.id}`)
      .send({ customerMessage: 'too late' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app)
      .patch('/api/invoices/nope')
      .send({ customerMessage: 'x' });
    expect(res.status).toBe(404);
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

describe('GET /api/invoices', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns an empty array when no invoices exist', async () => {
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all invoices for the tenant', async () => {
    await createInvoice(app);
    await createInvoice(app);
    const res = await request(app).get('/api/invoices');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toHaveProperty('invoiceNumber');
  });

  it('filters by jobId when the query parameter is provided', async () => {
    await createInvoice(app, { jobId: 'job-1' });
    await createInvoice(app, { jobId: 'job-2' });
    const res = await request(app).get('/api/invoices?jobId=job-2');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].jobId).toBe('job-2');
  });
});

describe('P1-018 — listInvoices filter + pagination', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('filter by status=draft returns only drafts', async () => {
    const r1 = await createInvoice(app, { jobId: 'job-1' });
    await createInvoice(app, { jobId: 'job-2' });
    // Issue r1 → status becomes 'open'
    await request(app).post(`/api/invoices/${r1.body.id}/issue`).send({});

    const res = await request(app).get('/api/invoices?status=draft');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('draft');
  });

  it('pagination with limit/offset returns { data, total }', async () => {
    for (let i = 0; i < 3; i++) {
      await createInvoice(app, { jobId: `job-${i}` });
    }
    const res = await request(app).get('/api/invoices?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(3);
  });

  it('rejects limit > 200 with 400', async () => {
    const res = await request(app).get('/api/invoices?limit=500');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('legacy ?jobId= still returns bare array (backwards compat)', async () => {
    await createInvoice(app, { jobId: 'job-1' });
    await createInvoice(app, { jobId: 'job-2' });
    const res = await request(app).get('/api/invoices?jobId=job-1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });
});

describe('POST /api/invoices/:id/payment', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  async function createOpenInvoice(overrides: Record<string, unknown> = {}) {
    const created = await createInvoice(app, overrides);
    await request(app)
      .post(`/api/invoices/${created.body.id}/issue`)
      .send({ paymentTermDays: 30 });
    return created.body.id as string;
  }

  it('records a full payment and transitions the invoice to paid', async () => {
    const invoiceId = await createOpenInvoice();
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 15000, method: 'cash' });

    expect(res.status).toBe(201);
    expect(res.body.payment.amountCents).toBe(15000);
    expect(res.body.payment.method).toBe('cash');
    expect(res.body.invoice.status).toBe('paid');
    expect(res.body.invoice.amountPaidCents).toBe(15000);
    expect(res.body.invoice.amountDueCents).toBe(0);
  });

  it('records a partial payment and transitions to partially_paid', async () => {
    const invoiceId = await createOpenInvoice();
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 5000, method: 'credit_card' });

    expect(res.status).toBe(201);
    expect(res.body.invoice.status).toBe('partially_paid');
    expect(res.body.invoice.amountPaidCents).toBe(5000);
    expect(res.body.invoice.amountDueCents).toBe(10000);
  });

  it('returns 400 for non-positive payment amounts', async () => {
    const invoiceId = await createOpenInvoice();
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 0, method: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for payments that exceed the amount due', async () => {
    const invoiceId = await createOpenInvoice();
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 99999, method: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when the invoice is still a draft', async () => {
    const created = await createInvoice(app);
    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/payment`)
      .send({ amountCents: 1000, method: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
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

  it('returns 400 for an invalid transition', async () => {
    const created = await createInvoice(app);
    expect(created.status).toBe(201);
    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/transition`)
      .send({ status: 'paid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
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

describe('POST /api/invoices/:id/payment-link (INV-04)', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 409 for draft invoice', async () => {
    const created = await createInvoice(app);
    expect(created.status).toBe(201);

    const res = await request(app).post(`/api/invoices/${created.body.id}/payment-link`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');
  });

  it('returns payment url for issued open invoice', async () => {
    const created = await createInvoice(app);
    await request(app)
      .post(`/api/invoices/${created.body.id}/issue`)
      .send({ paymentTermDays: 30 });

    const res = await request(app).post(`/api/invoices/${created.body.id}/payment-link`).send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.url).toBe('string');
    expect(res.body.url.length).toBeGreaterThan(0);
  });
});
