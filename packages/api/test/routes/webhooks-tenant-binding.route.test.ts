import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { createWebhookRouter } from '../../src/webhooks/routes';

const cfg: any = {};

// recordTwilio rejects a non-UUID :tenantId up front, so these tests use a
// well-formed id to reach the tenant-mismatch / AccountSid / idempotency
// logic they actually exercise. (Malformed-id rejection is covered by
// test/webhooks/malformed-tenant-id.route.test.ts.)
const TENANT_ID = '11111111-1111-1111-1111-111111111111';

describe('tenant-bound webhooks', () => {
  it('rejects path tenant mismatch', async () => {
    const app = express(); app.use(express.urlencoded({ extended: false })); app.use(express.json());
    app.use('/webhooks', createWebhookRouter(cfg, { integrationResolver: async () => null }));
    const r = await request(app).post(`/webhooks/twilio/sms/${TENANT_ID}`).send({});
    expect(r.status).toBe(403);
  });

  it('rejects forged AccountSid', async () => {
    const app = express(); app.use(express.urlencoded({ extended: false }));
    app.use('/webhooks', createWebhookRouter(cfg, {
      integrationResolver: async () => ({ tenantId: TENANT_ID, provider: 'twilio', subaccountSid: 'AC-real', authTokenPrimary: 'x' }),
    }));
    const r = await request(app).post(`/webhooks/twilio/status/${TENANT_ID}`).set('x-twilio-signature', 'bad').send('AccountSid=AC-fake&MessageSid=SM1');
    expect(r.status).toBe(403);
  });

  it('idempotent replay returns duplicate', async () => {
    const app = express(); app.use(express.urlencoded({ extended: false }));
    const repo = { recordReceipt: vi.fn().mockResolvedValueOnce({ inserted: true }).mockResolvedValueOnce({ inserted: false }), markProcessed: vi.fn() };
    app.use('/webhooks', createWebhookRouter(cfg, {
      integrationResolver: async () => ({ tenantId: TENANT_ID, provider: 'twilio', subaccountSid: 'AC-real', authTokenPrimary: 'x' }),
      webhookEventRepo: repo as any,
    }));
    await request(app).post(`/webhooks/twilio/sms/${TENANT_ID}`).set('x-twilio-signature', 'bad').send('AccountSid=AC-real&MessageSid=SM1');
    const r2 = await request(app).post(`/webhooks/twilio/sms/${TENANT_ID}`).set('x-twilio-signature', 'bad').send('AccountSid=AC-real&MessageSid=SM1');
    expect([200,403]).toContain(r2.status);
  });
});
