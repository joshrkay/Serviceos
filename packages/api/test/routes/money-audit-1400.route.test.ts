/**
 * #1400 (QA 2026-09-26 §4/§5) — invoice update / issue / send and estimate
 * send left NO audit row (db-21-audit-window-edit-issue-send.txt shows the
 * window empty of them). Every mutation emits an audit event attributable to
 * the actor. These are route-level domain events — I12′ tier 2 (best-effort):
 * the committed mutation is never unwound by an audit-store failure.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { buildTestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createEstimateRouter } from '../../src/routes/estimates';
import { InMemoryEstimateRepository, createEstimate } from '../../src/estimates/estimate';
import { createInvoiceRouter } from '../../src/routes/invoices';
import { InMemoryInvoiceRepository, createInvoice } from '../../src/invoices/invoice';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { SendService } from '../../src/notifications/send-service';

const LINES = [
  { id: 'li-1', description: 'Labor', quantity: 2, unitPriceCents: 4550, totalCents: 9100, category: 'labor', sortOrder: 0, taxable: true },
];

describe('invoice mutations write audit rows (#1400)', () => {
  let app: Express;
  let auditRepo: InMemoryAuditRepository;
  let invoiceId: string;

  beforeEach(async () => {
    ({ app, auditRepo } = await buildTestApp());
    const res = await request(app).post('/api/invoices').send({ jobId: 'job-1', invoiceNumber: 'X', lineItems: LINES });
    invoiceId = res.body.id;
  });

  const eventsFor = async (type: string) =>
    (await auditRepo.findByEntity(TEST_TENANT_ID, 'invoice', invoiceId)).filter((e) => e.eventType === type);

  it('PATCH /api/invoices/:id writes invoice.updated with the actor and the new total', async () => {
    const res = await request(app).patch(`/api/invoices/${invoiceId}`).send({ discountCents: 500 });
    expect(res.status).toBe(200);

    const [event] = await eventsFor('invoice.updated');
    expect(event).toBeDefined();
    expect(event.actorId).toBe(TEST_USER_ID);
    expect(event.actorRole).toBe('owner');
    // 9100 − 500 discount = 8600 before tax (no tax rate on this invoice)
    expect(event.metadata).toMatchObject({ previousTotalCents: 9100, totalCents: 8600 });
  });

  it('an audit-store outage does not fail or unwind the edit (I12′ tier 2, best-effort)', async () => {
    vi.spyOn(auditRepo, 'create').mockRejectedValue(new Error('audit store down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app).patch(`/api/invoices/${invoiceId}`).send({ discountCents: 500 });
    expect(res.status).toBe(200);
    const after = await request(app).get(`/api/invoices/${invoiceId}`);
    expect(after.body.totals.totalCents).toBe(8600);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invoice.updated'));
    vi.restoreAllMocks();
  });

  it('POST /api/invoices/:id/issue writes invoice.issued with the actor and due date', async () => {
    const res = await request(app).post(`/api/invoices/${invoiceId}/issue`).send({ paymentTermDays: 15 });
    expect(res.status).toBe(200);

    const [event] = await eventsFor('invoice.issued');
    expect(event).toBeDefined();
    expect(event.actorId).toBe(TEST_USER_ID);
    expect(event.metadata).toMatchObject({ paymentTermDays: 15, dueDate: res.body.dueDate, totalCents: 9100 });
  });
});

/** Mounts a router behind fake owner auth with a stubbed SendService. */
function mount(path: string, router: express.Router): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: TEST_USER_ID, sessionId: 's-1', tenantId: TEST_TENANT_ID, role: 'owner' };
    next();
  });
  app.use(path, router);
  return app;
}

const sendResult = (entity: 'estimateId' | 'invoiceId', id: string) => ({
  [entity]: id,
  viewUrl: 'https://example.test/e/tok',
  viewToken: 'tok',
  channelsSent: [{ channel: 'email', recipient: 'customer@example.test', provider: 'mock', providerMessageId: 'pm-1', dispatchId: 'dispatch-1' }],
});

describe('estimate send writes an audit row (#1400)', () => {
  it('POST /api/estimates/:id/send writes estimate.sent with the actor, channels and dispatch', async () => {
    const estimateRepo = new InMemoryEstimateRepository();
    const auditRepo = new InMemoryAuditRepository();
    const estimate = await createEstimate(
      { tenantId: TEST_TENANT_ID, jobId: 'job-1', estimateNumber: 'EST-0030', lineItems: LINES, createdBy: TEST_USER_ID },
      estimateRepo,
    );
    const sendService = { sendEstimate: vi.fn().mockResolvedValue(sendResult('estimateId', estimate.id)) } as unknown as SendService;
    const app = mount('/api/estimates', createEstimateRouter(
      estimateRepo, new InMemorySettingsRepository(), auditRepo, permissiveTenantOwnership(), sendService,
    ));

    const res = await request(app).post(`/api/estimates/${estimate.id}/send`).send({ channel: 'email' });
    expect(res.status).toBe(202);

    const events = (await auditRepo.findByEntity(TEST_TENANT_ID, 'estimate', estimate.id)).filter((e) => e.eventType === 'estimate.sent');
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(TEST_USER_ID);
    expect(events[0].metadata).toMatchObject({ channels: ['email'], dispatchIds: ['dispatch-1'] });
  });
});

describe('invoice send writes an audit row (#1400)', () => {
  it('POST /api/invoices/:id/send writes invoice.sent with the actor, channels and dispatch', async () => {
    const invoiceRepo = new InMemoryInvoiceRepository();
    const auditRepo = new InMemoryAuditRepository();
    const invoice = await createInvoice(
      { tenantId: TEST_TENANT_ID, jobId: 'job-1', invoiceNumber: 'INV-0026', lineItems: LINES, createdBy: TEST_USER_ID },
      invoiceRepo,
    );
    const sendService = { sendInvoice: vi.fn().mockResolvedValue(sendResult('invoiceId', invoice.id)) } as unknown as SendService;
    const app = mount('/api/invoices', createInvoiceRouter(
      invoiceRepo, new InMemorySettingsRepository(), auditRepo, permissiveTenantOwnership(), undefined, sendService,
    ));

    const res = await request(app).post(`/api/invoices/${invoice.id}/send`).send({ channel: 'email' });
    expect(res.status).toBe(202);

    const events = (await auditRepo.findByEntity(TEST_TENANT_ID, 'invoice', invoice.id)).filter((e) => e.eventType === 'invoice.sent');
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(TEST_USER_ID);
    expect(events[0].metadata).toMatchObject({ channels: ['email'], dispatchIds: ['dispatch-1'] });
  });
});

describe('invoice due date survives create and issue (#1400)', () => {
  let app: Express;
  beforeEach(async () => {
    ({ app } = await buildTestApp());
  });

  it('POST /api/invoices persists the chosen due date (YYYY-MM-DD) instead of dropping it', async () => {
    const res = await request(app).post('/api/invoices').send({ jobId: 'job-1', invoiceNumber: 'X', lineItems: LINES, dueDate: '2026-10-15' });
    expect(res.status).toBe(201);
    const got = await request(app).get(`/api/invoices/${res.body.id}`);
    expect(got.body.dueDate?.slice(0, 10)).toBe('2026-10-15');
  });

  it('issuing without explicit terms keeps the chosen due date (it was overwritten with issue + 30 days)', async () => {
    const created = await request(app).post('/api/invoices').send({ jobId: 'job-1', invoiceNumber: 'X', lineItems: LINES, dueDate: '2026-10-15' });
    const issued = await request(app).post(`/api/invoices/${created.body.id}/issue`).send({});
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('open');
    expect(issued.body.dueDate.slice(0, 10)).toBe('2026-10-15');
  });

  it('explicit paymentTermDays on issue still set the due date from the terms', async () => {
    const created = await request(app).post('/api/invoices').send({ jobId: 'job-1', invoiceNumber: 'X', lineItems: LINES, dueDate: '2026-10-15' });
    const issued = await request(app).post(`/api/invoices/${created.body.id}/issue`).send({ paymentTermDays: 0 });
    expect(issued.body.dueDate.slice(0, 10)).toBe(issued.body.issuedAt.slice(0, 10));
  });
});
