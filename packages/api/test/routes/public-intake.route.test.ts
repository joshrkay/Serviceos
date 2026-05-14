import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { createPublicIntakeRouter } from '../../src/routes/public-intake';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { DevInMemoryTenantRepository } from '../../src/auth/dev-auth-bypass';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryVerticalPackRegistry } from '../../src/shared/vertical-pack-registry';

describe('public-intake route', () => {
  let app: Express;
  let leadRepo: InMemoryLeadRepository;
  let auditRepo: InMemoryAuditRepository;
  let tenantRepo: DevInMemoryTenantRepository;
  let settingsRepo: InMemorySettingsRepository;
  let packRegistry: InMemoryVerticalPackRegistry;
  let tenantId: string;

  beforeEach(async () => {
    leadRepo = new InMemoryLeadRepository();
    auditRepo = new InMemoryAuditRepository();
    tenantRepo = new DevInMemoryTenantRepository();
    settingsRepo = new InMemorySettingsRepository();
    packRegistry = new InMemoryVerticalPackRegistry();
    const tenant = await tenantRepo.create({
      ownerId: 'owner-1',
      ownerEmail: 'owner@example.com',
      name: 'Test Co',
    });
    tenantId = tenant.id;

    app = express();
    app.use(express.json());
    app.use(
      '/public/intake',
      rateLimit({
        windowMs: 60_000,
        max: 10,
        standardHeaders: false,
        legacyHeaders: false,
      }),
      createPublicIntakeRouter(leadRepo, tenantRepo, auditRepo, settingsRepo, packRegistry),
    );
  });

  it('creates a lead with source=web_form and captured UTM', async () => {
    const res = await request(app)
      .post(`/public/intake/${tenantId}/leads`)
      .send({
        firstName: 'Sandra',
        lastName: 'Wu',
        primaryPhone: '5125550100',
        email: 'sandra@example.com',
        serviceType: 'HVAC',
        urgency: 'Emergency',
        description: 'AC stopped blowing cold air',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'spring_promo',
        attribution: { gclid: 'abc123' },
      });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.leadId).toBeTruthy();

    const lead = await leadRepo.findById(tenantId, res.body.leadId);
    expect(lead?.source).toBe('web_form');
    expect(lead?.utmCampaign).toBe('spring_promo');
    expect(lead?.attribution?.gclid).toBe('abc123');
    expect(lead?.sourceDetail).toContain('Service: HVAC');
    expect(lead?.sourceDetail).toContain('Description: AC stopped');
  });

  it('returns 200 OK but does not create a lead when honeypot is filled', async () => {
    const res = await request(app)
      .post(`/public/intake/${tenantId}/leads`)
      .send({
        firstName: 'Spam',
        primaryPhone: '5125550199',
        _company_url: 'http://spam.example.com',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.leadId).toBeUndefined();
    const all = await leadRepo.findByTenant(tenantId);
    expect(all).toHaveLength(0);
  });

  it('returns 404 for an unknown tenant', async () => {
    const res = await request(app)
      .post('/public/intake/00000000-0000-4000-8000-000000000099/leads')
      .send({ firstName: 'X', primaryPhone: '5125550100' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed tenant id', async () => {
    const res = await request(app)
      .post('/public/intake/not-a-uuid/leads')
      .send({ firstName: 'X', primaryPhone: '5125550100' });
    expect(res.status).toBe(400);
  });

  it('rejects payloads missing both phone and email', async () => {
    const res = await request(app)
      .post(`/public/intake/${tenantId}/leads`)
      .send({ firstName: 'Anon' });
    expect(res.status).toBe(400);
  });

  it('rate-limits after 10 requests/minute from the same IP', async () => {
    const send = () =>
      request(app)
        .post(`/public/intake/${tenantId}/leads`)
        .send({ firstName: 'L', primaryPhone: '5125550100' });
    for (let i = 0; i < 10; i++) {
      const r = await send();
      expect(r.status).toBe(201);
    }
    const r11 = await send();
    expect(r11.status).toBe(429);
  });

  describe('GET /public/intake/:tenantId', () => {
    it('returns business info and pack-derived service types for a configured tenant', async () => {
      await settingsRepo.create({
        id: 'settings-1',
        tenantId,
        businessName: 'Ortega HVAC & Services',
        businessPhone: '(512) 555-0100',
        timezone: 'America/Chicago',
        estimatePrefix: 'EST-',
        invoicePrefix: 'INV-',
        nextEstimateNumber: 1,
        nextInvoiceNumber: 1,
        defaultPaymentTermDays: 30,
        activeVerticalPacks: ['hvac-v1'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await packRegistry.register({
        id: 'pack-hvac-1',
        packId: 'hvac-v1',
        version: '1.0.0',
        verticalType: 'hvac',
        status: 'active',
        displayName: 'HVAC Services',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await request(app).get(`/public/intake/${tenantId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        businessName: 'Ortega HVAC & Services',
        businessPhone: '(512) 555-0100',
        serviceTypes: [{ verticalType: 'hvac', displayName: 'HVAC Services' }],
      });
    });

    it('falls back to the tenant name and empty service types when settings are absent', async () => {
      const res = await request(app).get(`/public/intake/${tenantId}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        businessName: 'Test Co',
        businessPhone: null,
        serviceTypes: [],
      });
    });

    it('returns 404 for an unknown tenant', async () => {
      const res = await request(app).get(
        '/public/intake/99999999-9999-4999-8999-999999999999',
      );
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Intake form not found' });
    });

    it('returns 400 for a malformed tenant id', async () => {
      const res = await request(app).get('/public/intake/not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
    });
  });
});
