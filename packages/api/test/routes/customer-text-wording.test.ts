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
    expect(res.body.languages).toEqual(['en', 'es']);
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
    expect(invoice.byLanguage.en.ours).toContain('https://app.example.com/pay/sample');
    expect(invoice.byLanguage.es.ours).toContain('https://app.example.com/pay/sample');
    expect(invoice.byLanguage.es.ours).not.toBe(invoice.byLanguage.en.ours);
    expect(invoice.byLanguage.en.saved).toBeNull();
    expect(invoice.byLanguage.es.saved).toBeNull();
    expect(res.body.texts[3].sampleValues).toEqual({ customer_name: 'Sam Rivera', business_name: 'Your service team' });
  });

  it('saves a wording (trimmed), shows it in the list, and audits it', async () => {
    const put = await request(app)
      .put('/api/settings/text-wording/invoice_text')
      .send({ body: '  Hi {{customer_name}}, pay here: {{link}}  ' });

    expect(put.status).toBe(200);
    expect(put.body.saved.body).toBe('Hi {{customer_name}}, pay here: {{link}}');
    const list = await request(app).get('/api/settings/text-wording');
    expect(list.body.texts[1].byLanguage.en.saved.body).toBe('Hi {{customer_name}}, pay here: {{link}}');
    expect(list.body.texts[1].byLanguage.es.saved).toBeNull();
    const events = await auditRepo.findByEntity(TENANT, 'customer_text_wording', 'invoice_text');
    expect(events.map((e) => e.eventType)).toEqual(['customer_text_wording.saved']);
  });

  it("with no language given, saves in the business's language", async () => {
    await settingsRepo.create({
      id: 's-1', tenantId: TENANT, businessName: 'Acme', timezone: 'America/Chicago', estimatePrefix: 'EST',
      invoicePrefix: 'INV', nextEstimateNumber: 1, nextInvoiceNumber: 1, defaultPaymentTermDays: 30,
      defaultLanguage: 'es', createdAt: new Date(), updatedAt: new Date(),
    });

    const put = await request(app).put('/api/settings/text-wording/thank_you_text').send({ body: '¡Gracias!' });

    expect(put.body.language).toBe('es');
    expect(await repo.find(TENANT, 'thank_you_text', 'es')).toMatchObject({ body: '¡Gracias!' });
  });

  it("keeps the one-language fields, in the business's language, for a screen on the previous web", async () => {
    await settingsRepo.create({
      id: 's-1', tenantId: TENANT, businessName: 'Acme', timezone: 'America/Chicago', estimatePrefix: 'EST',
      invoicePrefix: 'INV', nextEstimateNumber: 1, nextInvoiceNumber: 1, defaultPaymentTermDays: 30,
      defaultLanguage: 'es', createdAt: new Date(), updatedAt: new Date(),
    });
    // The previous screen sends no language on save or reset.
    await request(app).put('/api/settings/text-wording/thank_you_text').send({ body: '¡Gracias!' });
    await request(app).put('/api/settings/text-wording/thank_you_text').send({ body: 'Thanks!', language: 'en' });

    const list = await request(app).get('/api/settings/text-wording');
    const thanks = list.body.texts[3];
    expect(thanks.ours).toBe(thanks.byLanguage.es.ours);
    expect(thanks.addedLines).toEqual(thanks.byLanguage.es.addedLines);
    expect(thanks.saved).toMatchObject({ body: '¡Gracias!', language: 'es' });
    expect(list.body.texts[0].saved).toBeNull();

    await request(app).delete('/api/settings/text-wording/thank_you_text');
    expect(await repo.find(TENANT, 'thank_you_text', 'es')).toBeNull();
    expect(await repo.find(TENANT, 'thank_you_text', 'en')).toMatchObject({ body: 'Thanks!' });
  });

  it('saves and resets each language on its own', async () => {
    await request(app).put('/api/settings/text-wording/thank_you_text').send({ body: 'Thanks!', language: 'en' });
    const es = await request(app)
      .put('/api/settings/text-wording/thank_you_text')
      .send({ body: '¡Gracias!', language: 'es' });

    expect(es.status).toBe(200);
    expect(es.body.language).toBe('es');
    const list = await request(app).get('/api/settings/text-wording');
    expect(list.body.texts[3].byLanguage.en.saved.body).toBe('Thanks!');
    expect(list.body.texts[3].byLanguage.es.saved.body).toBe('¡Gracias!');

    const reset = await request(app).delete('/api/settings/text-wording/thank_you_text?language=es');
    expect(reset.status).toBe(200);
    expect(await repo.find(TENANT, 'thank_you_text', 'es')).toBeNull();
    expect(await repo.find(TENANT, 'thank_you_text', 'en')).toMatchObject({ body: 'Thanks!' });
    const events = await auditRepo.findByEntity(TENANT, 'customer_text_wording', 'thank_you_text');
    expect(events.map((e) => [e.eventType, e.metadata?.language])).toEqual([
      ['customer_text_wording.saved', 'en'],
      ['customer_text_wording.saved', 'es'],
      ['customer_text_wording.reset', 'es'],
    ]);
  });

  it('refuses a language it does not know', async () => {
    const put = await request(app).put('/api/settings/text-wording/thank_you_text').send({ body: 'Hi', language: 'vi' });
    const del = await request(app).delete('/api/settings/text-wording/thank_you_text?language=vi');
    expect(put.status).toBe(400);
    expect(del.status).toBe(400);
  });

  it("our invoice wording shows this business's payment mode (paid in person)", async () => {
    await settingsRepo.create({
      id: 's-2', tenantId: TENANT, businessName: 'Acme', timezone: 'America/Chicago', estimatePrefix: 'EST',
      invoicePrefix: 'INV', nextEstimateNumber: 1, nextInvoiceNumber: 1, defaultPaymentTermDays: 30,
      paymentCollectionMode: 'collect_on_site', createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await request(app).get('/api/settings/text-wording');

    const invoice = res.body.texts.find((t: { purpose: string }) => t.purpose === 'invoice_text');
    expect(invoice.byLanguage.en.ours).toMatch(/Acme collects payment in person/);
    expect(invoice.byLanguage.en.addedLines).toEqual(['Acme collects payment in person. Settle up when the work is done.']);
    expect(invoice.byLanguage.es.addedLines).toHaveLength(1);
    expect(invoice.byLanguage.es.addedLines[0]).not.toBe(invoice.byLanguage.en.addedLines[0]);
    expect(res.body.texts[0].byLanguage.en.addedLines).toEqual([]);
  });

  it('refuses a wording without the link, saying why, and saves nothing', async () => {
    const res = await request(app).put('/api/settings/text-wording/estimate_text').send({ body: 'Your estimate is ready' });

    expect(res.status).toBe(400);
    expect(res.body.problems).toEqual(['Include {{link}} so the customer can open it.']);
    expect(await repo.find(TENANT, 'estimate_text', 'en')).toBeNull();
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
    await repo.save(TENANT, 'thank_you_text', 'Thanks!', 'en', USER);

    const first = await request(app).delete('/api/settings/text-wording/thank_you_text');
    const second = await request(app).delete('/api/settings/text-wording/thank_you_text');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await repo.find(TENANT, 'thank_you_text', 'en')).toBeNull();
    const events = await auditRepo.findByEntity(TENANT, 'customer_text_wording', 'thank_you_text');
    expect(events.map((e) => e.eventType)).toEqual(['customer_text_wording.reset']);
  });

  it('a technician can neither read nor change the wording', async () => {
    role = 'technician';
    expect((await request(app).get('/api/settings/text-wording')).status).toBe(403);
    expect((await request(app).put('/api/settings/text-wording/thank_you_text').send({ body: 'Hi' })).status).toBe(403);
  });
});
