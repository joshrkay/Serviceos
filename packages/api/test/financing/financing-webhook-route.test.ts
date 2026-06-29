import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFinancingWebhookRouter } from '../../src/routes/financing';
import { InMemoryFinancingRepository, offerFinancing } from '../../src/financing/financing';
import { ManualFinancingProvider } from '../../src/financing/financing-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';

const TENANT = '11111111-1111-1111-1111-111111111111';
const SECRET = 'whsec_test';

function makeApp(repo: InMemoryFinancingRepository) {
  const app = express();
  // Raw body, exactly like the production mount, so the HMAC matches.
  app.use('/webhooks/wisetack', express.raw({ type: '*/*' }));
  app.use(
    '/webhooks/wisetack',
    createFinancingWebhookRouter({
      financingRepo: repo,
      auditRepo: new InMemoryAuditRepository(),
      webhookSecret: SECRET,
    }),
  );
  return app;
}

describe('financing webhook route (FIN)', () => {
  let repo: InMemoryFinancingRepository;
  let app: express.Express;

  beforeEach(() => {
    repo = new InMemoryFinancingRepository();
    app = makeApp(repo);
  });

  async function seedApplication() {
    return offerFinancing(
      {
        tenantId: TENANT,
        invoiceId: '22222222-2222-2222-2222-222222222222',
        amountCents: 120_00,
        invoiceNumber: 'INV-1',
        customerName: 'Pat',
        createdBy: 'user-1',
      },
      repo,
      new ManualFinancingProvider(),
    );
  }

  function post(body: unknown) {
    const payload = JSON.stringify(body);
    const signature = createWebhookSignature(payload, SECRET);
    return request(app)
      .post('/webhooks/wisetack')
      .set('Content-Type', 'application/json')
      .set('x-wisetack-signature', signature)
      .send(payload);
  }

  it('resolves the application from external_reference and applies the status', async () => {
    const app1 = await seedApplication();
    const res = await post({
      external_reference: `${TENANT}:${app1.id}`,
      status: 'authorized',
      status_reason: 'approved by lender',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, applied: true });
    const updated = await repo.findById(TENANT, app1.id);
    expect(updated?.status).toBe('approved');
  });

  it('rejects a bad signature', async () => {
    const res = await request(app)
      .post('/webhooks/wisetack')
      .set('Content-Type', 'application/json')
      .set('x-wisetack-signature', 't=1,v1=deadbeef')
      .send(JSON.stringify({ external_reference: `${TENANT}:x`, status: 'authorized' }));
    expect(res.status).toBe(401);
  });

  it('400s when external_reference is missing or malformed', async () => {
    const res = await post({ status: 'authorized' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REFERENCE');
  });

  it('200s (acknowledges) an unknown application so the provider stops retrying', async () => {
    const res = await post({
      external_reference: `${TENANT}:99999999-9999-9999-9999-999999999999`,
      status: 'declined',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, applied: false });
  });
});
