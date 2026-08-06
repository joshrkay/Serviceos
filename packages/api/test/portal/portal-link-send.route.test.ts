/**
 * Portal link distribution — POST /api/portal-sessions/send.
 *
 * The mint route (POST /api/portal-sessions) returns the plaintext token
 * exactly once and only ever stores its hash, so "send the customer their
 * portal link" cannot be a follow-up call on an existing session id — the
 * send endpoint mints a fresh session and delivers the composed URL through
 * the SAME SendService/GatedMessageDelivery machinery the estimate/invoice
 * sends use. These tests pin:
 *
 *   - auth gating (401 without req.auth)
 *   - 503 when message delivery is not configured
 *   - happy-path SMS + email delivery with the portal URL in the body
 *   - consent + DNC gating (enforcement 'block') — suppressed dispatch row,
 *     nothing reaches the provider, and the just-minted (never-delivered)
 *     session is revoked so no live bearer credential dangles
 *   - dispatch ledger rows (entity_type 'portal_session')
 *   - audit events: portal_session.created + portal_session.link_sent
 */
import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryPortalSessionRepository } from '../../src/portal/portal-session';
import {
  InMemoryCustomerRepository,
  Customer,
} from '../../src/customers/customer';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { SendService } from '../../src/notifications/send-service';
import { createPortalRouter } from '../../src/routes/portal';

const TENANT = uuidv4();
const ACTOR = 'user-portal-send';

interface Harness {
  app: express.Express;
  portalRepo: InMemoryPortalSessionRepository;
  customerRepo: InMemoryCustomerRepository;
  auditRepo: InMemoryAuditRepository;
  dispatchRepo: InMemoryDispatchRepository;
  delivery: InMemoryDeliveryProvider;
  dnc: InMemoryDncRepository;
  customer: Customer;
}

async function build(opts: {
  customer?: Partial<Customer>;
  /** Omit the SendService entirely (delivery-not-configured environments). */
  withoutSendService?: boolean;
  /** Skip the fake-auth middleware so requireAuth sees no req.auth. */
  unauthenticated?: boolean;
} = {}): Promise<Harness> {
  const portalRepo = new InMemoryPortalSessionRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const auditRepo = new InMemoryAuditRepository();
  const dispatchRepo = new InMemoryDispatchRepository();
  const delivery = new InMemoryDeliveryProvider();
  const dnc = new InMemoryDncRepository();
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
    ...opts.customer,
  });

  // Same wiring shape as app.ts: SendService over the single gated delivery
  // wrapper — consent/DNC enforcement is NOT re-implemented by the route.
  const sendService = opts.withoutSendService
    ? undefined
    : new SendService({
        delivery: new GatedMessageDelivery({
          base: delivery,
          dnc,
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
  if (!opts.unauthenticated) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: ACTOR,
        sessionId: 'session-1',
        tenantId: TENANT,
        role: 'owner',
      };
      next();
    });
  }
  app.use(
    '/api/portal-sessions',
    createPortalRouter({ portalRepo, customerRepo, auditRepo, sendService }),
  );

  return { app, portalRepo, customerRepo, auditRepo, dispatchRepo, delivery, dnc, customer };
}

describe('POST /api/portal-sessions/send — auth + configuration gates', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const h = await build({ unauthenticated: true });
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: h.customer.id, channel: 'sms' });
    expect(res.status).toBe(401);
    expect(h.delivery.sentSms).toHaveLength(0);
  });

  it('returns 503 NOT_CONFIGURED when message delivery is not wired', async () => {
    const h = await build({ withoutSendService: true });
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: h.customer.id, channel: 'sms' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('NOT_CONFIGURED');
  });

  it('rejects an invalid customerId shape with 400', async () => {
    const h = await build();
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: 'not-a-uuid', channel: 'sms' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown customer and mints nothing', async () => {
    const h = await build();
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: uuidv4(), channel: 'sms' });
    expect(res.status).toBe(404);
    expect(h.delivery.sentSms).toHaveLength(0);
    const audits = h.auditRepo.getAll();
    expect(audits.filter((e) => e.eventType === 'portal_session.created')).toHaveLength(0);
  });
});

describe('POST /api/portal-sessions/send — happy path', () => {
  it('mints a session and texts the portal link; dispatch + audits recorded', async () => {
    const h = await build();
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: h.customer.id, channel: 'sms' });

    expect(res.status).toBe(202);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.customerId).toBe(h.customer.id);
    expect(res.body.url).toMatch(/\/portal\/[0-9a-f]{64}$/);
    expect(res.body.expiresAt).toBeTruthy();
    expect(res.body.channelsSent).toHaveLength(1);
    expect(res.body.channelsSent[0].channel).toBe('sms');
    expect(res.body.channelsSent[0].recipient).toBe('+15555550100');

    // The customer actually received the link.
    expect(h.delivery.sentSms).toHaveLength(1);
    expect(h.delivery.sentSms[0].to).toBe('+15555550100');
    expect(h.delivery.sentSms[0].body).toContain(res.body.url);

    // Dispatch ledger row keyed to the minted portal session.
    const dispatches = await h.dispatchRepo.findByEntity(
      TENANT,
      'portal_session',
      res.body.sessionId,
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].channel).toBe('sms');
    expect(dispatches[0].status).toBe('sent');
    expect(dispatches[0].provider).toBe('in-memory');

    // Audit trail: the mint AND the send are both recorded on the session.
    const audits = await h.auditRepo.findByEntity(
      TENANT,
      'portal_session',
      res.body.sessionId,
    );
    const types = audits.map((e) => e.eventType);
    expect(types).toContain('portal_session.created');
    expect(types).toContain('portal_session.link_sent');
    const sent = audits.find((e) => e.eventType === 'portal_session.link_sent')!;
    expect(sent.actorId).toBe(ACTOR);
    expect(sent.metadata?.customerId).toBe(h.customer.id);
    expect(sent.metadata?.channels).toEqual(['sms']);
  });

  it('emails the portal link on channel: email', async () => {
    const h = await build();
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: h.customer.id, channel: 'email' });

    expect(res.status).toBe(202);
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(1);
    expect(h.delivery.sentEmails[0].to).toBe('pat@example.com');
    expect(h.delivery.sentEmails[0].text).toContain(res.body.url);
    const dispatches = await h.dispatchRepo.findByEntity(
      TENANT,
      'portal_session',
      res.body.sessionId,
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].channel).toBe('email');
  });

  it("''→undefined: untouched send-sheet recipient fields fall back to the customer on file", async () => {
    const h = await build();
    const res = await request(h.app).post('/api/portal-sessions/send').send({
      customerId: h.customer.id,
      channel: 'sms',
      recipientPhone: '',
      recipientEmail: '',
      customMessage: '',
    });
    expect(res.status).toBe(202);
    expect(h.delivery.sentSms[0].to).toBe('+15555550100');
  });

  it('P11-002 — localizes the SMS when the customer prefers Spanish', async () => {
    const h = await build({ customer: { preferredLanguage: 'es' } });
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: h.customer.id, channel: 'sms' });
    expect(res.status).toBe(202);
    expect(h.delivery.sentSms[0].body).toContain('su portal de cliente');
  });
});

describe('POST /api/portal-sessions/send — consent/DNC gating (never weakened)', () => {
  it('suppresses SMS without stored consent: 400, suppressed dispatch row, session revoked', async () => {
    const h = await build({ customer: { smsConsent: false } });
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: h.customer.id, channel: 'sms' });

    expect(res.status).toBe(400);
    // Nothing reached the provider.
    expect(h.delivery.sentSms).toHaveLength(0);

    // The suppression is recorded on the dispatch ledger like every other
    // gated send (provider='suppressed', status='failed').
    const created = h.auditRepo
      .getAll()
      .find((e) => e.eventType === 'portal_session.created');
    expect(created).toBeTruthy();
    const sessionId = created!.entityId;
    const dispatches = await h.dispatchRepo.findByEntity(
      TENANT,
      'portal_session',
      sessionId,
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].provider).toBe('suppressed');
    expect(dispatches[0].status).toBe('failed');

    // A minted-but-never-delivered token must not stay live.
    const session = await h.portalRepo.findById(TENANT, sessionId);
    expect(session?.revokedAt).toBeInstanceOf(Date);

    // And no false "link_sent" audit.
    const types = h.auditRepo.getAll().map((e) => e.eventType);
    expect(types).not.toContain('portal_session.link_sent');
    expect(types).toContain('portal_session.revoked');
  });

  it('suppresses SMS to a DNC-listed number even with smsConsent=true', async () => {
    const h = await build();
    h.dnc.add(TENANT, normalizePhone('+15555550100'));
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: h.customer.id, channel: 'sms' });

    expect(res.status).toBe(400);
    expect(h.delivery.sentSms).toHaveLength(0);
    const types = h.auditRepo.getAll().map((e) => e.eventType);
    expect(types).not.toContain('portal_session.link_sent');
  });

  it('partial success stands: channel both with SMS suppressed still emails and 202s', async () => {
    const h = await build({ customer: { smsConsent: false } });
    const res = await request(h.app)
      .post('/api/portal-sessions/send')
      .send({ customerId: h.customer.id, channel: 'both' });

    expect(res.status).toBe(202);
    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(1);
    expect(res.body.channelsSent.map((c: { channel: string }) => c.channel)).toEqual(['email']);
    // Session stays live — the customer DID get the link (by email).
    const session = await h.portalRepo.findById(TENANT, res.body.sessionId);
    expect(session?.revokedAt).toBeUndefined();
  });
});
