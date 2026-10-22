/**
 * D-045 — an owner's estimate send that no channel delivered still answers
 * 400, but commits (res.locals.forceCommit): the refused text's message
 * record, with the reason, is what the status bubble shows, and a rollback
 * would erase it. Any other error keeps the default rollback.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createEstimateRouter } from '../../src/routes/estimates';
import { InMemoryEstimateRepository, type Estimate } from '../../src/estimates/estimate';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { SendService } from '../../src/notifications/send-service';
import type { TenantOwnership } from '../../src/shared/tenant-ownership';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { withOutbound } from '../helpers/outbound-messaging';

const TENANT = 'tenant-est-send-1';
const USER = 'user-est-send-1';

describe('POST /api/estimates/:id/send — a send nothing delivered keeps its records (D-045)', () => {
  let app: Express;
  let estimateId: string;
  let dispatchRepo: InMemoryDispatchRepository;
  let lastForceCommit: unknown;

  beforeEach(async () => {
    lastForceCommit = undefined;
    const estimateRepo = new InMemoryEstimateRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const jobRepo = new InMemoryJobRepository();
    const settingsRepo = new InMemorySettingsRepository();
    dispatchRepo = new InMemoryDispatchRepository();
    const auditRepo = new InMemoryAuditRepository();
    const now = new Date();

    const customer = await customerRepo.create({
      id: uuidv4(), tenantId: TENANT, firstName: 'Ana', lastName: 'Nosms', displayName: 'Ana Nosms',
      primaryPhone: '+15555550123', preferredChannel: 'sms', smsConsent: false, isArchived: false,
      createdBy: USER, createdAt: now, updatedAt: now,
    });
    const job = await jobRepo.create({
      id: uuidv4(), tenantId: TENANT, customerId: customer.id, locationId: 'loc-1', jobNumber: 'JOB-1',
      summary: 'Furnace', status: 'scheduled', priority: 'normal', createdBy: USER, createdAt: now, updatedAt: now,
    });
    estimateId = uuidv4();
    await estimateRepo.create({
      id: estimateId, tenantId: TENANT, jobId: job.id, estimateNumber: 'EST-1', status: 'ready_for_review',
      lineItems: [], totals: { subtotalCents: 10000, taxCents: 0, totalCents: 10000, discountCents: 0 },
      version: 1, createdBy: USER, createdAt: now, updatedAt: now,
    } as unknown as Estimate);

    const sendService = new SendService(withOutbound({
      delivery: new GatedMessageDelivery({
        base: new InMemoryDeliveryProvider(),
        dnc: new InMemoryDncRepository(),
        auditRepo,
        enforcement: 'block',
      }),
      estimateRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
      jobRepo,
      customerRepo,
      settingsRepo,
      dispatchRepo,
      publicBaseUrl: 'https://app.example.com',
      ensureInvoicePayLink: async () => undefined,
    }));
    const ownership: TenantOwnership = {
      async requireExists() {},
      async requireExistsAndLoad() {
        return undefined;
      },
    };

    app = express();
    app.use(express.json());
    app.use((req: Request, res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's', tenantId: TENANT, role: 'owner' };
      res.on('finish', () => {
        lastForceCommit = res.locals.forceCommit;
      });
      next();
    });
    app.use('/api/estimates', createEstimateRouter(estimateRepo, settingsRepo, auditRepo, ownership, sendService));
  });

  it('a refused text answers 400 and commits, keeping its blocked record', async () => {
    const res = await request(app).post(`/api/estimates/${estimateId}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no_consent/);
    expect(lastForceCommit).toBe(true);
    const { dispatches } = await dispatchRepo.listByTenant(TENANT);
    expect(dispatches).toMatchObject([{ status: 'blocked', blockReason: 'no_consent', entityId: estimateId }]);
  });

  it('any other refusal keeps the default rollback', async () => {
    const res = await request(app).post(`/api/estimates/${uuidv4()}/send`).send({ channel: 'sms' });

    expect(res.status).toBe(404);
    expect(lastForceCommit).toBeUndefined();
  });
});
