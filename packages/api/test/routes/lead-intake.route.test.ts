import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { createLeadIntakeRouter } from '../../src/routes/lead-intake';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { DevInMemoryTenantRepository } from '../../src/auth/dev-auth-bypass';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';

const SECRET = 'whsec_test_lead_intake';

function signed(app: Express, tenantId: string, payload: unknown, secret = SECRET) {
  const raw = JSON.stringify(payload);
  return request(app)
    .post(`/webhooks/lead-intake/${tenantId}/leads`)
    .set('Content-Type', 'application/json')
    .set('x-webhook-signature', createWebhookSignature(raw, secret))
    .send(raw);
}

describe('lead-intake signed webhook route', () => {
  let app: Express;
  let leadRepo: InMemoryLeadRepository;
  let auditRepo: InMemoryAuditRepository;
  let customerRepo: InMemoryCustomerRepository;
  let tenantRepo: DevInMemoryTenantRepository;
  let tenantId: string;

  async function buildApp(signingSecret: string | undefined) {
    app = express();
    app.use('/webhooks/lead-intake', express.raw({ type: 'application/json' }));
    app.use(
      '/webhooks/lead-intake',
      createLeadIntakeRouter({ leadRepo, tenantRepo, auditRepo, customerRepo, signingSecret }),
    );
  }

  beforeEach(async () => {
    leadRepo = new InMemoryLeadRepository();
    auditRepo = new InMemoryAuditRepository();
    customerRepo = new InMemoryCustomerRepository();
    tenantRepo = new DevInMemoryTenantRepository();
    const tenant = await tenantRepo.create({
      ownerId: 'owner-1',
      ownerEmail: 'owner@example.com',
      name: 'Test Co',
    });
    tenantId = tenant.id;
    await buildApp(SECRET);
  });

  const validLead = {
    source: 'web_form',
    firstName: 'Sandra',
    lastName: 'Wu',
    primaryPhone: '5125550100',
    email: 'sandra@example.com',
    sourceDetail: 'AC stopped',
    utmSource: 'google',
  };

  it('creates a lead from a valid signed submission and retains the raw payload', async () => {
    const res = await signed(app, tenantId, validLead);
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.leadId).toBeTruthy();

    const lead = await leadRepo.findById(tenantId, res.body.leadId);
    expect(lead?.source).toBe('web_form');
    expect(lead?.primaryPhone).toBe('5125550100');
    expect(lead?.utmSource).toBe('google');
    // The verbatim submission is retained for the inbox.
    expect(lead?.rawPayload).toMatchObject({ source: 'web_form', firstName: 'Sandra' });

    const audits = auditRepo.getAll().filter((a) => a.entityId === lead!.id);
    expect(audits.some((a) => a.eventType === 'lead.created')).toBe(true);
  });

  it('rejects a submission with no signature header (400)', async () => {
    const res = await request(app)
      .post(`/webhooks/lead-intake/${tenantId}/leads`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(validLead));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid signature (401)', async () => {
    const raw = JSON.stringify(validLead);
    const res = await request(app)
      .post(`/webhooks/lead-intake/${tenantId}/leads`)
      .set('Content-Type', 'application/json')
      .set('x-webhook-signature', createWebhookSignature(raw, 'wrong-secret'))
      .send(raw);
    expect(res.status).toBe(401);
    expect(await leadRepo.findByTenant(tenantId)).toHaveLength(0);
  });

  it('fails closed (500) when no signing secret is configured', async () => {
    await buildApp(undefined);
    const res = await signed(app, tenantId, validLead);
    expect(res.status).toBe(500);
  });

  it('rejects a malformed payload with a field-level error (400)', async () => {
    const res = await signed(app, tenantId, { source: 'web_form', firstName: 'NoContact' });
    expect(res.status).toBe(400);
    expect(await leadRepo.findByTenant(tenantId)).toHaveLength(0);
  });

  it('rejects an internal-origin source that an external channel may not forge', async () => {
    const res = await signed(app, tenantId, { ...validLead, source: 'phone_call' });
    expect(res.status).toBe(400);
  });

  it('dedups an identical replayed delivery (idempotency) — only one lead', async () => {
    const first = await signed(app, tenantId, validLead);
    expect(first.status).toBe(201);
    const second = await signed(app, tenantId, validLead);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(await leadRepo.findByTenant(tenantId)).toHaveLength(1);
  });

  it('flags (does not duplicate) a second open lead with the same phone', async () => {
    const first = await signed(app, tenantId, validLead);
    expect(first.status).toBe(201);
    // Different body (distinct sourceDetail) so this is NOT an idempotency replay,
    // but the same phone — must be flagged, not duplicated.
    const second = await signed(app, tenantId, { ...validLead, sourceDetail: 'second touch' });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.leadId).toBe(first.body.leadId);
    expect(await leadRepo.findByTenant(tenantId)).toHaveLength(1);

    const dupAudit = auditRepo.getAll().find((a) => a.eventType === 'lead.intake_duplicate');
    expect(dupAudit).toBeTruthy();
  });

  it('flags a possible existing-customer match without blocking lead creation', async () => {
    const now = new Date();
    await customerRepo.create({
      id: crypto.randomUUID(),
      tenantId,
      firstName: 'Sandra',
      lastName: 'Wu',
      displayName: 'Sandra Wu',
      primaryPhone: '5125550100',
      email: 'sandra@example.com',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: 'owner-1',
      createdAt: now,
      updatedAt: now,
    });

    const res = await signed(app, tenantId, validLead);
    expect(res.status).toBe(201);
    expect(res.body.leadId).toBeTruthy();
    expect(res.body.possibleCustomerMatches.length).toBeGreaterThan(0);
    // The lead is still created (flagged, not blocked).
    expect(await leadRepo.findByTenant(tenantId)).toHaveLength(1);
    const matchAudit = auditRepo.getAll().find((a) => a.eventType === 'lead.intake_customer_match');
    expect(matchAudit).toBeTruthy();
  });

  it('rejects a non-UUID tenant id (400)', async () => {
    const res = await signed(app, 'not-a-uuid', validLead);
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown tenant', async () => {
    const res = await signed(app, '00000000-0000-4000-8000-000000000099', validLead);
    expect(res.status).toBe(404);
  });
});
