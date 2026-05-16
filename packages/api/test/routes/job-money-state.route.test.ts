import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildTestApp, TestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import { v4 as uuidv4 } from 'uuid';

describe('job money-state — route wiring', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  async function seedJob(): Promise<string> {
    const job = await ctx.jobRepo.create({
      id: uuidv4(),
      tenantId: TEST_TENANT_ID,
      customerId: uuidv4(),
      locationId: uuidv4(),
      jobNumber: 'JOB-0001',
      summary: 'AC repair',
      status: 'new',
      priority: 'normal',
      moneyState: 'no_estimate',
      createdBy: TEST_USER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return job.id;
  }

  it('issuing an invoice flips the job money-state to invoiced', async () => {
    const jobId = await seedJob();
    const created = await request(ctx.app)
      .post('/api/invoices')
      .send({
        jobId,
        lineItems: [
          {
            id: uuidv4(),
            description: 'Labor',
            quantity: 1,
            unitPriceCents: 12000,
            totalCents: 12000,
            sortOrder: 0,
            taxable: true,
          },
        ],
      });
    expect(created.status).toBe(201);

    const issued = await request(ctx.app)
      .post(`/api/invoices/${created.body.id}/issue`)
      .send({ paymentTermDays: 30 });
    expect(issued.status).toBe(200);

    const job = await ctx.jobRepo.findById(TEST_TENANT_ID, jobId);
    expect(job!.moneyState).toBe('invoiced');
  });

  it('transitioning an estimate to sent flips the job money-state to estimate_sent', async () => {
    const jobId = await seedJob();
    const created = await request(ctx.app)
      .post('/api/estimates')
      .send({
        jobId,
        lineItems: [
          {
            id: uuidv4(),
            description: 'Diagnostic',
            quantity: 1,
            unitPriceCents: 8000,
            totalCents: 8000,
            sortOrder: 0,
            taxable: true,
          },
        ],
      });
    expect(created.status).toBe(201);

    const transitioned = await request(ctx.app)
      .post(`/api/estimates/${created.body.id}/transition`)
      .send({ status: 'sent' });
    expect(transitioned.status).toBe(200);

    const job = await ctx.jobRepo.findById(TEST_TENANT_ID, jobId);
    expect(job!.moneyState).toBe('estimate_sent');
  });
});
