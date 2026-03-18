/**
 * Layer 1 — Route Shape Tests: Estimates
 *
 * Proves that the estimates endpoints return the fields the UI reads
 * (estimateNumber, status, totals.totalCents) and that all money values
 * are integers (never floats).
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp } from './test-app';
import type { Express } from 'express';

const SAMPLE_LINE_ITEMS = [
  {
    id: 'li-1',
    description: 'Diagnostic fee',
    quantity: 1,
    unitPriceCents: 9500,
    totalCents: 9500,
    category: 'labor',
    sortOrder: 0,
    taxable: false,
  },
];

async function createEstimate(app: Express, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/estimates')
    .send({
      jobId: 'job-1',
      // estimateNumber is required by the schema but auto-generated server-side;
      // any non-empty string passes Zod and the server overwrites it.
      estimateNumber: 'PLACEHOLDER',
      lineItems: SAMPLE_LINE_ITEMS,
      ...overrides,
    });
}

describe('POST /api/estimates', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 201 with an estimate containing the required UI fields', async () => {
    const res = await createEstimate(app);

    expect(res.status).toBe(201);
    const est = res.body;
    expect(typeof est.id).toBe('string');
    expect(typeof est.estimateNumber).toBe('string');
    expect(est.estimateNumber).toMatch(/^EST-/);
    expect(est.status).toBe('draft');
    expect(est.jobId).toBe('job-1');
  });

  it('totals are integers (never floats)', async () => {
    const res = await createEstimate(app, {
      lineItems: [
        { id: 'li-1', description: 'Labor', quantity: 2, unitPriceCents: 4750, totalCents: 9500, category: 'labor', sortOrder: 0, taxable: false },
      ],
    });

    expect(res.status).toBe(201);
    const { totals } = res.body;
    expect(Number.isInteger(totals.subtotalCents)).toBe(true);
    expect(Number.isInteger(totals.totalCents)).toBe(true);
    expect(Number.isInteger(totals.discountCents)).toBe(true);
    expect(Number.isInteger(totals.taxCents)).toBe(true);
  });

  it('calculates totalCents correctly from line items', async () => {
    // 2 items: 9500 + 5000 = 14500
    const res = await createEstimate(app, {
      lineItems: [
        { id: 'li-1', description: 'Diagnostic', quantity: 1, unitPriceCents: 9500, totalCents: 9500, category: 'labor', sortOrder: 0, taxable: false },
        { id: 'li-2', description: 'Part', quantity: 1, unitPriceCents: 5000, totalCents: 5000, category: 'material', sortOrder: 1, taxable: false },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.totals.subtotalCents).toBe(14500);
    expect(res.body.totals.totalCents).toBe(14500);
  });

  it('applies tax when taxRateBps is provided', async () => {
    // 10000 cents * 10% (1000 bps) = 1000 tax → total 11000
    const res = await createEstimate(app, {
      lineItems: [
        { id: 'li-1', description: 'Service', quantity: 1, unitPriceCents: 10000, totalCents: 10000, category: 'labor', sortOrder: 0, taxable: true },
      ],
      taxRateBps: 1000,
    });

    expect(res.status).toBe(201);
    expect(res.body.totals.taxCents).toBe(1000);
    expect(res.body.totals.totalCents).toBe(11000);
  });

  it('auto-increments estimate numbers sequentially', async () => {
    const r1 = await createEstimate(app);
    const r2 = await createEstimate(app);
    expect(r1.body.estimateNumber).toBe('EST-0001');
    expect(r2.body.estimateNumber).toBe('EST-0002');
  });

  it('returns an error when lineItems is empty', async () => {
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: [],  // fails min(1) validation
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).toHaveProperty('error');
  });
});

describe('GET /api/estimates/:id', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns 200 with the estimate when found', async () => {
    const created = await createEstimate(app);
    const res = await request(app).get(`/api/estimates/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.estimateNumber).toBe(created.body.estimateNumber);
  });

  it('returns 404 for unknown estimate id', async () => {
    const res = await request(app).get('/api/estimates/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});

describe('POST /api/estimates/:id/transition', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('transitions draft → sent and returns the updated estimate', async () => {
    const created = await createEstimate(app);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');

    const res = await request(app)
      .post(`/api/estimates/${created.body.id}/transition`)
      .send({ status: 'sent' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sent');
  });

  it('transitions sent → accepted', async () => {
    const created = await createEstimate(app);
    await request(app)
      .post(`/api/estimates/${created.body.id}/transition`)
      .send({ status: 'sent' });

    const res = await request(app)
      .post(`/api/estimates/${created.body.id}/transition`)
      .send({ status: 'accepted' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
  });

  it('returns an error for invalid transition', async () => {
    const created = await createEstimate(app);
    expect(created.status).toBe(201);
    // draft → accepted is not a valid transition.
    // The lifecycle throws a plain Error so the server returns 5xx.
    const res = await request(app)
      .post(`/api/estimates/${created.body.id}/transition`)
      .send({ status: 'accepted' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('returns 400 when status is missing', async () => {
    const created = await createEstimate(app);
    const res = await request(app)
      .post(`/api/estimates/${created.body.id}/transition`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
