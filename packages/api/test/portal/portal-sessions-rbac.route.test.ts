/**
 * Portal sessions — role gating on the authed mint / mint+send / revoke routes.
 *
 * A portal token is a bearer credential: with no contactId it resolves with
 * the `billing` entitlement, so the holder reads the customer's invoices,
 * estimates, agreements and payment methods, and can book / cancel /
 * reschedule appointments. rbac.ts DELIBERATELY withholds invoices:*,
 * estimates:*, payments:* and appointments:create/update from `technician`
 * (see the billing-isolation note there). `/api/portal-sessions` used to sit
 * behind only `requireAuth, requireTenant`, so a technician could mint (or
 * mint+send, with a free-form recipient/message) a token and read exactly the
 * data RBAC withholds — or revoke any customer's link.
 *
 * Gate: `customers:update` — the family permission every customer-record
 * mutation uses (customers.ts, including the contacts a contact-bound
 * session binds to), mirroring how estimate/invoice link sends are gated by
 * `estimates:update` / `invoices:update`. Owner + dispatcher hold it;
 * technician holds only customers:view.
 *
 * Seam: the HTTP router (`createPortalRouter`) over supertest with injected
 * in-memory fakes, role supplied through the same `req.auth` the real
 * `requireAuth` reads.
 */
import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Role } from '../../src/auth/rbac';
import { InMemoryPortalSessionRepository } from '../../src/portal/portal-session';
import { InMemoryCustomerRepository, Customer } from '../../src/customers/customer';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { SendService } from '../../src/notifications/send-service';
import { createPortalRouter } from '../../src/routes/portal';

const TENANT = uuidv4();
const ACTOR = 'user-portal-rbac';

interface Harness {
  app: express.Express;
  portalRepo: InMemoryPortalSessionRepository;
  auditRepo: InMemoryAuditRepository;
  delivery: InMemoryDeliveryProvider;
  customer: Customer;
}

async function build(role: Role): Promise<Harness> {
  const portalRepo = new InMemoryPortalSessionRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const auditRepo = new InMemoryAuditRepository();
  const dispatchRepo = new InMemoryDispatchRepository();
  const delivery = new InMemoryDeliveryProvider();
  const settingsRepo = new InMemorySettingsRepository();

  await settingsRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    timezone: 'America/New_York',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const customer = await customerRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    firstName: 'Pat',
    lastName: 'Customer',
    displayName: 'Pat Customer',
    email: 'pat@example.com',
    primaryPhone: '+15555550100',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const sendService = new SendService({
    delivery: new GatedMessageDelivery({
      base: delivery,
      dnc: new InMemoryDncRepository(),
      auditRepo,
      enforcement: 'block',
    }),
    estimateRepo: new InMemoryEstimateRepository(),
    invoiceRepo: new InMemoryInvoiceRepository(),
    jobRepo: new InMemoryJobRepository(),
    customerRepo,
    settingsRepo,
    dispatchRepo,
    publicBaseUrl: 'https://app.example.com',
  });

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: ACTOR,
      sessionId: 'session-rbac',
      tenantId: TENANT,
      role,
    };
    next();
  });
  app.use(
    '/api/portal-sessions',
    createPortalRouter({ portalRepo, customerRepo, auditRepo, sendService }),
  );

  return { app, portalRepo, auditRepo, delivery, customer };
}

const FORBIDDEN_BODY = { error: 'FORBIDDEN', message: 'Insufficient permissions' };

describe('portal sessions — owner and dispatcher keep working exactly as before', () => {
  it('owner: POST / mints a session (201) and writes portal_session.created', async () => {
    const h = await build('owner');
    const res = await request(h.app)
      .post('/api/portal-sessions')
      .send({ customerId: h.customer.id });

    expect(res.status).toBe(201);
    expect(res.body.token).toHaveLength(64);
    expect(res.body.customerId).toBe(h.customer.id);

    const events = h.auditRepo.getAll().filter((e) => e.eventType === 'portal_session.created');
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(ACTOR);
    expect(events[0].actorRole).toBe('owner');
    expect(events[0].entityId).toBe(res.body.id);
  });

  it('dispatcher: POST / mints a session (201)', async () => {
    const h = await build('dispatcher');
    const res = await request(h.app)
      .post('/api/portal-sessions')
      .send({ customerId: h.customer.id });

    expect(res.status).toBe(201);
    expect(res.body.token).toHaveLength(64);
    const events = h.auditRepo.getAll().filter((e) => e.eventType === 'portal_session.created');
    expect(events).toHaveLength(1);
    expect(events[0].actorRole).toBe('dispatcher');
  });
});

describe('portal sessions — technician is refused (no customers:update)', () => {
  it('POST / answers 403 FORBIDDEN and mints nothing', async () => {
    const h = await build('technician');
    const res = await request(h.app)
      .post('/api/portal-sessions')
      .send({ customerId: h.customer.id });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN_BODY);
    expect(h.auditRepo.getAll()).toHaveLength(0);
  });

  it('POST /send answers 403 FORBIDDEN: nothing minted, nothing delivered', async () => {
    const h = await build('technician');
    const res = await request(h.app).post('/api/portal-sessions/send').send({
      customerId: h.customer.id,
      channel: 'sms',
      // The free-form fields are the abuse vector: delivery from the
      // business identity to an arbitrary recipient with arbitrary text.
      recipientPhone: '+15555559999',
      customMessage: 'pay this invoice at the link below',
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN_BODY);
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(0);
    expect(h.auditRepo.getAll()).toHaveLength(0);
  });

  it('DELETE /:id answers 403 FORBIDDEN and leaves the session live', async () => {
    const h = await build('technician');
    const sessionId = uuidv4();
    await h.portalRepo.create({
      id: sessionId,
      tenantId: TENANT,
      customerId: h.customer.id,
      tokenHash: 'hash-portal-rbac',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdBy: 'someone-else',
      createdAt: new Date(),
    });

    const res = await request(h.app).delete(`/api/portal-sessions/${sessionId}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN_BODY);
    const after = await h.portalRepo.findById(TENANT, sessionId);
    expect(after?.revokedAt).toBeUndefined();
    expect(h.auditRepo.getAll()).toHaveLength(0);
  });
});
