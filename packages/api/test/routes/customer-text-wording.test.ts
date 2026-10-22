import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createCustomerTextWordingRouter } from '../../src/notifications/customer-text-wording-router';
import { InMemoryCustomerTextWordingRepository } from '../../src/notifications/customer-text-wording';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = '00000000-0000-4000-8000-00000000c7a1';
const USER = 'user-wording-1';

describe('/api/settings/text-wording (D-045)', () => {
  let app: Express;
  let repo: InMemoryCustomerTextWordingRepository;
  let auditRepo: InMemoryAuditRepository;
  let settingsRepo: InMemorySettingsRepository;
  let role: string;

  beforeEach(async () => {
    repo = new InMemoryCustomerTextWordingRepository();
    auditRepo = new InMemoryAuditRepository();
    settingsRepo = new InMemorySettingsRepository();
    role = 'owner';
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's', tenantId: TENANT, role };
      next();
    });
    app.use(
      '/api/settings/text-wording',
      createCustomerTextWordingRouter({ repo, settingsRepo, auditRepo, publicBaseUrl: 'https://app.example.com/' }),
    );
  });

  it('lists every text with its fill-ins, sample values and our wording', async () => {
    const res = await request(app).get('/api/settings/text-wording');

    expect(res.status).toBe(200);
    expect(res.body.language).toBe('en');
    expect(res.body.maxLength).toBe(480);
    expect(res.body.texts.map((t: { purpose: string }) => t.purpose)).toEqual([
      'estimate_text',
      'invoice_text',
      'portal_link_text',
      'thank_you_text',
    ]);
    const invoice = res.body.texts[1];
    expect(invoice.fillIns).toEqual(['customer_name', 'business_name', 'number', 'total', 'link']);
    expect(invoice.sampleValues.link).toBe('https://app.example.com/pay/sample');
    expect(invoice.ours).toContain('https://app.example.com/pay/sample');
    expect(invoice.saved).toBeNull();
    expect(res.body.texts[3].sampleValues).toEqual({ customer_name: 'Sam Rivera', business_name: 'Your service team' });
  });

  it('saves a wording (trimmed), shows it in the list, and audits it', async () => {
    const put = await request(app)
      .put('/api/settings/text-wording/invoice_text')
      .send({ body: '  Hi {{customer_name}}, pay here: {{link}}  ' });

    expect(put.status).toBe(200);
    expect(put.body.saved.body).toBe('Hi {{customer_name}}, pay here: {{link}}');
    const list = await request(app).get('/api/settings/text-wording');
    expect(list.body.texts[1].saved.body).toBe('Hi {{customer_name}}, pay here: {{link}}');
    const events = await auditRepo.findByEntity(TENANT, 'customer_text_wording', 'invoice_text');
    expect(events.map((e) => e.eventType)).toEqual(['customer_text_wording.saved']);
  });

  it('refuses a wording without the link, saying why, and saves nothing', async () => {
    const res = await request(app).put('/api/settings/text-wording/estimate_text').send({ body: 'Your estimate is ready' });

    expect(res.status).toBe(400);
    expect(res.body.problems).toEqual(['Include {{link}} so the customer can open it.']);
    expect(await repo.find(TENANT, 'estimate_text')).toBeNull();
  });

  it('refuses a body that is not text', async () => {
    const res = await request(app).put('/api/settings/text-wording/estimate_text').send({ body: 42 });
    expect(res.status).toBe(400);
  });

  it('answers 404 for a text that does not exist', async () => {
    expect((await request(app).put('/api/settings/text-wording/marketing').send({ body: 'x' })).status).toBe(404);
    expect((await request(app).delete('/api/settings/text-wording/marketing')).status).toBe(404);
  });

  it('reset removes the wording and audits it; a second reset is a quiet no-op', async () => {
    await repo.save(TENANT, 'thank_you_text', 'Thanks!', USER);

    const first = await request(app).delete('/api/settings/text-wording/thank_you_text');
    const second = await request(app).delete('/api/settings/text-wording/thank_you_text');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await repo.find(TENANT, 'thank_you_text')).toBeNull();
    const events = await auditRepo.findByEntity(TENANT, 'customer_text_wording', 'thank_you_text');
    expect(events.map((e) => e.eventType)).toEqual(['customer_text_wording.reset']);
  });

  it('a technician can neither read nor change the wording', async () => {
    role = 'technician';
    expect((await request(app).get('/api/settings/text-wording')).status).toBe(403);
    expect((await request(app).put('/api/settings/text-wording/thank_you_text').send({ body: 'Hi' })).status).toBe(403);
  });
});
