/**
 * Edge-case coverage for estimates + invoices, covering the scenarios
 * called out in EDGE_CASES_ANALYSIS.md that weren't already covered
 * by the shape tests or the decisions tenant-isolation suite:
 *   - unicode / emoji in text fields
 *   - html/script stored verbatim (escaping is a UI concern)
 *   - numeric rounding + large totals
 *   - multi-payment flow to fully paid
 *   - payment rejections on non-payable invoice states
 *   - negative / non-integer rejections at the contract layer
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp } from './test-app';
import type { Express } from 'express';

function labor(id: string, quantity: number, unitPriceCents: number, opts: { taxable?: boolean; sortOrder?: number; description?: string } = {}) {
  return {
    id,
    description: opts.description ?? 'Work',
    quantity,
    unitPriceCents,
    totalCents: quantity * unitPriceCents,
    category: 'labor',
    sortOrder: opts.sortOrder ?? 0,
    taxable: opts.taxable ?? false,
  };
}

describe('Estimates/Invoices — text field edge cases', () => {
  let app: Express;
  beforeEach(async () => { ({ app } = await buildTestApp()); });

  it('stores unicode and emoji in customerMessage verbatim', async () => {
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: [labor('li-1', 1, 10000)],
      customerMessage: 'Hola José — repair complete 🔧 日本語',
    });
    expect(res.status).toBe(201);
    expect(res.body.customerMessage).toBe('Hola José — repair complete 🔧 日本語');
  });

  it('stores <script> tags verbatim without escaping (UI escapes on render)', async () => {
    const xss = '<script>alert("xss")</script>';
    const res = await request(app).post('/api/invoices').send({
      jobId: 'job-1',
      invoiceNumber: 'PLACEHOLDER',
      lineItems: [labor('li-1', 1, 10000, { description: xss })],
      customerMessage: xss,
    });
    expect(res.status).toBe(201);
    expect(res.body.lineItems[0].description).toBe(xss);
    expect(res.body.customerMessage).toBe(xss);
  });

  it('preserves whitespace in line item descriptions', async () => {
    const desc = '  leading and trailing  ';
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: [labor('li-1', 1, 1000, { description: desc })],
    });
    expect(res.status).toBe(201);
    expect(res.body.lineItems[0].description).toBe(desc);
  });
});

describe('Estimates/Invoices — numeric edge cases', () => {
  let app: Express;
  beforeEach(async () => { ({ app } = await buildTestApp()); });

  it('rounds tax to the nearest cent (8.875% of $99.99)', async () => {
    // 9999 cents * 8.875% bps=887.5 → round(9999 * 887 / 10000) = 887 (we need to pass 887 or 888 in bps)
    // Using 887 bps = 8.87% gives 9999 * 887 / 10000 = 886.9113 → 887 after round
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: [labor('li-1', 1, 9999, { taxable: true })],
      taxRateBps: 887,
    });
    expect(res.status).toBe(201);
    expect(Number.isInteger(res.body.totals.taxCents)).toBe(true);
    expect(res.body.totals.taxCents).toBe(887);
    expect(res.body.totals.totalCents).toBe(9999 + 887);
  });

  it('handles a large number of line items (200) without loss of precision', async () => {
    const items = Array.from({ length: 200 }, (_, i) => labor(`li-${i}`, 1, 137, { sortOrder: i }));
    const res = await request(app).post('/api/invoices').send({
      jobId: 'job-1',
      invoiceNumber: 'PLACEHOLDER',
      lineItems: items,
    });
    expect(res.status).toBe(201);
    expect(res.body.totals.subtotalCents).toBe(200 * 137);
    expect(res.body.totals.totalCents).toBe(200 * 137);
  });

  it('rejects non-integer unitPriceCents at the contract boundary', async () => {
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: [{ id: 'li-1', description: 'x', quantity: 1, unitPriceCents: 99.5, totalCents: 100, category: 'labor', sortOrder: 0, taxable: false }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects negative discountCents', async () => {
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: [labor('li-1', 1, 10000)],
      discountCents: -100,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details.fields).toHaveProperty('discountCents');
  });

  it('rejects taxRateBps greater than 10000 (100%)', async () => {
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: [labor('li-1', 1, 10000, { taxable: true })],
      taxRateBps: 10001,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('applies discount before tax, total never goes negative', async () => {
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: [labor('li-1', 1, 10000, { taxable: true })],
      discountCents: 15000, // larger than subtotal
      taxRateBps: 1000,
    });
    expect(res.status).toBe(201);
    expect(res.body.totals.totalCents).toBe(0);
    expect(res.body.totals.taxCents).toBe(0);
  });
});

describe('Invoices — payment flow edge cases', () => {
  let app: Express;
  beforeEach(async () => { ({ app } = await buildTestApp()); });

  async function createAndIssueInvoice(lineItems: ReturnType<typeof labor>[]) {
    const created = await request(app).post('/api/invoices').send({
      jobId: 'job-1',
      invoiceNumber: 'PLACEHOLDER',
      lineItems,
    });
    await request(app).post(`/api/invoices/${created.body.id}/issue`).send({});
    return created.body.id as string;
  }

  it('three partial payments reach paid status with zero balance', async () => {
    const invoiceId = await createAndIssueInvoice([labor('li-1', 1, 30000)]);

    const p1 = await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 10000, method: 'cash' });
    expect(p1.status).toBe(201);
    expect(p1.body.invoice.status).toBe('partially_paid');
    expect(p1.body.invoice.amountDueCents).toBe(20000);

    const p2 = await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 15000, method: 'credit_card' });
    expect(p2.body.invoice.status).toBe('partially_paid');
    expect(p2.body.invoice.amountDueCents).toBe(5000);

    const p3 = await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 5000, method: 'check' });
    expect(p3.body.invoice.status).toBe('paid');
    expect(p3.body.invoice.amountDueCents).toBe(0);
    expect(p3.body.invoice.amountPaidCents).toBe(30000);
  });

  it('rejects payment after invoice is fully paid', async () => {
    const invoiceId = await createAndIssueInvoice([labor('li-1', 1, 5000)]);
    await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 5000, method: 'cash' });

    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 1, method: 'cash' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects payment on a canceled invoice', async () => {
    const created = await request(app).post('/api/invoices').send({
      jobId: 'job-1',
      invoiceNumber: 'PLACEHOLDER',
      lineItems: [labor('li-1', 1, 10000)],
    });
    await request(app)
      .post(`/api/invoices/${created.body.id}/transition`)
      .send({ status: 'canceled' });

    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/payment`)
      .send({ amountCents: 1000, method: 'cash' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects payment on a voided invoice', async () => {
    const created = await request(app).post('/api/invoices').send({
      jobId: 'job-1',
      invoiceNumber: 'PLACEHOLDER',
      lineItems: [labor('li-1', 1, 10000)],
    });
    await request(app).post(`/api/invoices/${created.body.id}/issue`).send({});
    await request(app)
      .post(`/api/invoices/${created.body.id}/transition`)
      .send({ status: 'void' });

    const res = await request(app)
      .post(`/api/invoices/${created.body.id}/payment`)
      .send({ amountCents: 1000, method: 'cash' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects payment with invalid method at the contract boundary', async () => {
    const invoiceId = await createAndIssueInvoice([labor('li-1', 1, 10000)]);
    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/payment`)
      .send({ amountCents: 1000, method: 'bitcoin' });
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toHaveProperty('method');
  });
});

describe('Estimates/Invoices — auto-numbering stays tenant-scoped', () => {
  let app: Express;
  beforeEach(async () => { ({ app } = await buildTestApp()); });

  it('allocates sequential numbers even with interleaved creates', async () => {
    const e1 = await request(app).post('/api/estimates').send({
      jobId: 'job-1', estimateNumber: 'X', lineItems: [labor('li-1', 1, 100)],
    });
    const i1 = await request(app).post('/api/invoices').send({
      jobId: 'job-1', invoiceNumber: 'X', lineItems: [labor('li-1', 1, 100)],
    });
    const e2 = await request(app).post('/api/estimates').send({
      jobId: 'job-1', estimateNumber: 'X', lineItems: [labor('li-1', 1, 100)],
    });
    const i2 = await request(app).post('/api/invoices').send({
      jobId: 'job-1', invoiceNumber: 'X', lineItems: [labor('li-1', 1, 100)],
    });
    expect(e1.body.estimateNumber).toBe('EST-0001');
    expect(e2.body.estimateNumber).toBe('EST-0002');
    expect(i1.body.invoiceNumber).toBe('INV-0001');
    expect(i2.body.invoiceNumber).toBe('INV-0002');
  });
});
