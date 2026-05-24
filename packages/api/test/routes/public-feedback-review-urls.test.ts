import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPublicFeedbackRouter } from '../../src/routes/public-feedback';
import {
  InMemoryFeedbackRequestRepository,
  createFeedbackRequest,
} from '../../src/feedback/feedback-request';
import { InMemoryFeedbackResponseRepository } from '../../src/feedback/feedback-response';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';

const TENANT = 't-1';

async function makeApp(reviewUrls?: { google?: string | null; yelp?: string | null }) {
  const requestRepo = new InMemoryFeedbackRequestRepository();
  const responseRepo = new InMemoryFeedbackResponseRepository();
  const settingsRepo = new InMemorySettingsRepository();

  const now = new Date();
  const settings: TenantSettings = {
    id: 's-1',
    tenantId: TENANT,
    businessName: 'Ortega HVAC',
    timezone: 'America/Chicago',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    googleReviewUrl: reviewUrls?.google ?? null,
    yelpReviewUrl: reviewUrls?.yelp ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await settingsRepo.create(settings);

  const req = await requestRepo.create(createFeedbackRequest({ tenantId: TENANT, jobId: 'j-1' }));

  const app = express();
  app.use(express.json());
  app.use('/public/feedback', createPublicFeedbackRouter(requestRepo, responseRepo, settingsRepo));
  return { app, token: req.token };
}

describe('POST /public/feedback/:token — review URLs', () => {
  it('returns review links for a 4★+ rating when configured', async () => {
    const { app, token } = await makeApp({
      google: 'https://g.page/r/abc',
      yelp: 'https://www.yelp.com/biz/ortega',
    });
    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      ok: true,
      reviewUrls: { google: 'https://g.page/r/abc', yelp: 'https://www.yelp.com/biz/ortega' },
    });
  });

  it('omits review links for a rating below 4', async () => {
    const { app, token } = await makeApp({ google: 'https://g.page/r/abc' });
    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 3 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('omits review links when none are configured', async () => {
    const { app, token } = await makeApp();
    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('includes only the configured link', async () => {
    const { app, token } = await makeApp({ google: 'https://g.page/r/abc', yelp: null });
    const res = await request(app).post(`/public/feedback/${token}`).send({ rating: 4 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, reviewUrls: { google: 'https://g.page/r/abc' } });
  });
});
