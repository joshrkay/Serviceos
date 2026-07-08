/**
 * GET /public/feedback/:token Accept negotiation.
 *
 * The exact API path is also what stale SMS links pointed browsers at, so
 * browser navigations (Accept: text/html) must 302 to the SPA page at
 * /feedback/:token — even for unknown tokens (the page owns invalid-token
 * UX) — while JSON clients keep the original response byte-for-byte.
 */
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

async function makeApp() {
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

describe('GET /public/feedback/:token — Accept negotiation', () => {
  it('302-redirects browser navigations (Accept: text/html) to the SPA page', async () => {
    const { app, token } = await makeApp();
    const res = await request(app)
      .get(`/public/feedback/${token}`)
      .set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/feedback/${token}`);
  });

  it('serves JSON unchanged for Accept: application/json', async () => {
    const { app, token } = await makeApp();
    const res = await request(app)
      .get(`/public/feedback/${token}`)
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({
      status: 'pending',
      jobId: 'j-1',
      businessName: 'Ortega HVAC',
    });
  });

  it('still 302s an unknown token for text/html — the page owns invalid-token UX', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .get('/public/feedback/nope-not-a-token')
      .set('Accept', 'text/html');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/feedback/nope-not-a-token');
  });

  it('keeps the JSON 404 for an unknown token when the client asks for JSON', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .get('/public/feedback/nope-not-a-token')
      .set('Accept', 'application/json');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Feedback request not found' });
  });
});
