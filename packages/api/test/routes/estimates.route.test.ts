/**
 * Layer 1 — Route Shape Tests: Estimates
 *
 * Proves that the estimates endpoints return the fields the UI reads
 * (estimateNumber, status, totals.totalCents) and that all money values
 * are integers (never floats).
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import { createCustomer } from '../../src/customers/customer';
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

  it('returns 400 with field errors when lineItems is empty', async () => {
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: [],  // fails min(1) validation
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details).toHaveProperty('fields');
    expect(res.body.details.fields).toHaveProperty('lineItems');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/api/estimates').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(res.body.details.fields).toHaveProperty('jobId');
  });
});

describe('PATCH /api/estimates/:id', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('updates a draft estimate and recalculates totals', async () => {
    const created = await createEstimate(app, { taxRateBps: 0 });
    const res = await request(app)
      .patch(`/api/estimates/${created.body.id}`)
      .send({
        lineItems: [
          { id: 'li-1', description: 'Revised', quantity: 2, unitPriceCents: 5000, totalCents: 10000, category: 'labor', sortOrder: 0, taxable: false },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.totals.subtotalCents).toBe(10000);
    expect(res.body.totals.totalCents).toBe(10000);
  });

  it('returns 409 when plain-editing a sent estimate (must use revise)', async () => {
    const created = await createEstimate(app);
    await request(app)
      .post(`/api/estimates/${created.body.id}/transition`)
      .send({ status: 'sent' });

    const res = await request(app)
      .patch(`/api/estimates/${created.body.id}`)
      .send({ customerMessage: 'too late' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CONFLICT');

    // ...but the dedicated revise endpoint succeeds and bumps the version.
    const revised = await request(app)
      .post(`/api/estimates/${created.body.id}/revise`)
      .send({ customerMessage: 'updated pricing' });
    expect(revised.status).toBe(200);
    expect(revised.body.status).toBe('sent');
    expect(revised.body.version).toBe(2);
    expect(revised.body.customerMessage).toBe('updated pricing');
  });

  it('enforces optimistic locking via If-Match on edits', async () => {
    const created = await createEstimate(app);
    expect(created.body.version).toBe(1);

    // Correct version → succeeds and bumps to 2.
    const ok = await request(app)
      .patch(`/api/estimates/${created.body.id}`)
      .set('If-Match', '1')
      .send({ customerMessage: 'first' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);

    // Re-using the now-stale version 1 is refused with 409.
    const stale = await request(app)
      .patch(`/api/estimates/${created.body.id}`)
      .set('If-Match', '1')
      .send({ customerMessage: 'second' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('CONFLICT');

    // Omitting If-Match stays backward compatible (no lock enforced).
    const noHeader = await request(app)
      .patch(`/api/estimates/${created.body.id}`)
      .send({ customerMessage: 'third' });
    expect(noHeader.status).toBe(200);
    expect(noHeader.body.version).toBe(3);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app)
      .patch('/api/estimates/nope')
      .send({ customerMessage: 'x' });
    expect(res.status).toBe(404);
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

describe('GET /api/estimates', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns an empty array when no estimates exist', async () => {
    const res = await request(app).get('/api/estimates');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns all estimates for the tenant', async () => {
    await createEstimate(app);
    await createEstimate(app);
    const res = await request(app).get('/api/estimates');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toHaveProperty('estimateNumber');
  });

  it('filters by jobId when the query parameter is provided', async () => {
    await createEstimate(app, { jobId: 'job-1' });
    await createEstimate(app, { jobId: 'job-2' });
    const res = await request(app).get('/api/estimates?jobId=job-1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].jobId).toBe('job-1');
  });

  it('journey QA bug 5 — list rows carry a customer summary resolved via the linked job', async () => {
    const { app: freshApp, customerRepo } = await buildTestApp();
    const customer = await createCustomer(
      { tenantId: TEST_TENANT_ID, firstName: 'Sarah', lastName: 'Henderson', createdBy: TEST_USER_ID },
      customerRepo,
    );
    const jobRes = await request(freshApp).post('/api/jobs').send({
      customerId: customer.id,
      locationId: 'loc-1',
      summary: 'Water heater install',
    });
    await createEstimate(freshApp, { jobId: jobRes.body.id });

    // Bare-array shape
    const bare = await request(freshApp).get('/api/estimates');
    expect(bare.status).toBe(200);
    expect(bare.body[0].customer).toMatchObject({
      id: customer.id,
      displayName: 'Sarah Henderson',
      firstName: 'Sarah',
      lastName: 'Henderson',
    });

    // Paginated shape
    const paged = await request(freshApp).get('/api/estimates?paginated=true');
    expect(paged.status).toBe(200);
    expect(paged.body.data[0].customer.displayName).toBe('Sarah Henderson');

    // An estimate on a job with no resolvable customer stays unenriched.
    await createEstimate(freshApp, { jobId: 'job-orphan' });
    const all = await request(freshApp).get('/api/estimates');
    const orphan = all.body.find((e: { jobId: string }) => e.jobId === 'job-orphan');
    expect(orphan.customer).toBeUndefined();
  });
});

describe('P1-018 — listEstimates filter + pagination', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('filter by status=draft returns only drafts', async () => {
    const e1 = await createEstimate(app);
    await createEstimate(app);
    // Transition e1 to sent
    await request(app).post(`/api/estimates/${e1.body.id}/transition`).send({ status: 'sent' });

    const res = await request(app).get('/api/estimates?status=draft');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('draft');
  });

  it('pagination with limit/offset returns { data, total }', async () => {
    for (let i = 0; i < 3; i++) {
      await createEstimate(app);
    }
    const res = await request(app).get('/api/estimates?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(3);
  });

  it('rejects limit > 200 with 400', async () => {
    const res = await request(app).get('/api/estimates?limit=500');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('legacy ?jobId= without other params still returns bare array', async () => {
    await createEstimate(app, { jobId: 'job-a' });
    await createEstimate(app, { jobId: 'job-b' });
    const res = await request(app).get('/api/estimates?jobId=job-a');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });
});

describe('7.10 — GET /api/estimates customer filter', () => {
  let app: Express;
  let jobRepo: Awaited<ReturnType<typeof buildTestApp>>['jobRepo'];

  beforeEach(async () => {
    ({ app, jobRepo } = await buildTestApp());
    // estimates only carry job_id; the route resolves customerId → jobIds
    // via the customer's jobs, so seed jobs for two customers.
    const base = {
      tenantId: TEST_TENANT_ID,
      locationId: 'loc-1',
      summary: 'Work',
      status: 'scheduled' as const,
      priority: 'normal' as const,
      createdBy: TEST_USER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await jobRepo.create({ ...base, id: 'job-A', customerId: 'cust-1', jobNumber: 'JOB-A' });
    await jobRepo.create({ ...base, id: 'job-B', customerId: 'cust-2', jobNumber: 'JOB-B' });
  });

  it('filters estimates by customerId via the customer’s jobs', async () => {
    await createEstimate(app, { jobId: 'job-A' });
    await createEstimate(app, { jobId: 'job-A' });
    await createEstimate(app, { jobId: 'job-B' });

    const res = await request(app).get('/api/estimates?customerId=cust-1&paginated=true');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data.every((e: { jobId: string }) => e.jobId === 'job-A')).toBe(true);
  });

  it('combines the customer filter with status', async () => {
    const e1 = await createEstimate(app, { jobId: 'job-A' });
    await createEstimate(app, { jobId: 'job-A' });
    await request(app).post(`/api/estimates/${e1.body.id}/transition`).send({ status: 'sent' });

    const res = await request(app).get('/api/estimates?customerId=cust-1&status=sent');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(e1.body.id);
  });

  it('returns an empty result for a customer with no jobs', async () => {
    await createEstimate(app, { jobId: 'job-A' });
    const res = await request(app).get('/api/estimates?customerId=ghost&paginated=true');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0 });
  });
});

describe('7.10 — GET /api/estimates/:id/history', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('returns the recorded edit deltas after an edit', async () => {
    const created = await createEstimate(app, { taxRateBps: 0 });
    await request(app)
      .patch(`/api/estimates/${created.body.id}`)
      .send({
        lineItems: [
          { id: 'li-1', description: 'Revised', quantity: 2, unitPriceCents: 5000, totalCents: 10000, category: 'labor', sortOrder: 0, taxable: false },
        ],
      });

    const res = await request(app).get(`/api/estimates/${created.body.id}/history`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('summary');
    expect(res.body[0]).toHaveProperty('deltas');
  });

  it('returns an empty array for an estimate with no edits', async () => {
    const created = await createEstimate(app);
    const res = await request(app).get(`/api/estimates/${created.body.id}/history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 404 for an unknown estimate', async () => {
    const res = await request(app).get('/api/estimates/nope/history');
    expect(res.status).toBe(404);
  });
});

describe('7.9 — POST /api/estimates/:id/save-as-template', () => {
  let app: Express;

  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('creates a tenant-scoped template from the estimate', async () => {
    const created = await createEstimate(app, { taxRateBps: 825 });
    const res = await request(app)
      .post(`/api/estimates/${created.body.id}/save-as-template`)
      .send({ name: 'AC Tune-up', verticalType: 'hvac', categoryId: 'hvac-repair-ac' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('AC Tune-up');
    expect(res.body.verticalType).toBe('hvac');
    expect(res.body.defaultTaxRateBps).toBe(825);
    expect(res.body.lineItemTemplates).toHaveLength(1);
    expect(res.body.lineItemTemplates[0].description).toBe('Diagnostic fee');
    expect(res.body.lineItemTemplates[0].defaultUnitPriceCents).toBe(9500);
  });

  it('returns 404 for an unknown estimate', async () => {
    const res = await request(app)
      .post('/api/estimates/nope/save-as-template')
      .send({ name: 'X', verticalType: 'hvac', categoryId: 'c1' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when name or classification is missing', async () => {
    const created = await createEstimate(app);
    const res = await request(app)
      .post(`/api/estimates/${created.body.id}/save-as-template`)
      .send({ verticalType: 'hvac' }); // missing name + categoryId
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
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

  it('returns 400 for an invalid transition', async () => {
    const created = await createEstimate(app);
    expect(created.status).toBe(201);
    const res = await request(app)
      .post(`/api/estimates/${created.body.id}/transition`)
      .send({ status: 'accepted' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
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
