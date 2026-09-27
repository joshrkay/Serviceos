/**
 * #1400 — GET /api/estimates?stage=sent|viewed|expired backs the list tabs
 * (Sent previously queried only ready_for_review; Viewed never matched;
 * Expired never listed past-validity estimates). Real-Postgres semantics are
 * pinned in test/integration/estimate-list-stage-search-1400.test.ts.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { buildTestApp, TEST_TENANT_ID } from './test-app';

const LINES = [
  { id: 'li-1', description: 'Labor', quantity: 1, unitPriceCents: 10000, totalCents: 10000, category: 'labor', sortOrder: 0, taxable: false },
];

describe('GET /api/estimates?stage= (#1400)', () => {
  let app: Express;
  let estimateRepo: Awaited<ReturnType<typeof buildTestApp>>['estimateRepo'];
  const DAY = 24 * 60 * 60 * 1000;

  async function make(patch: Record<string, unknown>): Promise<string> {
    const res = await request(app).post('/api/estimates').send({ jobId: 'job-1', estimateNumber: 'X', lineItems: LINES });
    await estimateRepo.update(TEST_TENANT_ID, res.body.id, patch);
    return res.body.id;
  }

  beforeEach(async () => {
    ({ app, estimateRepo } = await buildTestApp());
  });

  it('stage=viewed returns only sent estimates the customer opened', async () => {
    await make({ status: 'sent', sentAt: new Date() });
    const viewed = await make({ status: 'sent', sentAt: new Date(), firstViewedAt: new Date(), validUntil: new Date(Date.now() + DAY) });
    await make({ status: 'draft' });

    const res = await request(app).get('/api/estimates?stage=viewed&paginated=true');
    expect(res.status).toBe(200);
    expect(res.body.data.map((e: { id: string }) => e.id)).toEqual([viewed]);
    expect(res.body.total).toBe(1);
  });

  it('rejects an unknown stage with 400', async () => {
    const res = await request(app).get('/api/estimates?stage=bogus');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('estimate line quantity is validated the same on create and edit (#1400)', () => {
  it('POST /api/estimates refuses a quantity-0 line, as the editor already does on edit', async () => {
    const { app } = await buildTestApp();
    const res = await request(app).post('/api/estimates').send({
      jobId: 'job-1', estimateNumber: 'X',
      lineItems: [{ ...LINES[0], quantity: 0, totalCents: 0 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).toContain('quantity must be more than 0');
  });
});
