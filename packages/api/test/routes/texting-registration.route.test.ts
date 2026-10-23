/**
 * #1564 — owner-only API for the A2P 10DLC texting registration
 * (Settings → Phone: submit the business details, read the status).
 *
 * Seam: the mounted router (GET / PUT /api/settings/texting-registration)
 * over the real service + in-memory store, inside a stand-in request
 * transaction.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import type { Pool, PoolClient } from 'pg';
import { describe, it, expect, vi } from 'vitest';
import { createTextingRegistrationRouter } from '../../src/routes/texting-registration';
import { A2P_REGISTRATION_JOB_TYPE, createA2pRegistrationService } from '../../src/integrations/twilio/a2p-10dlc/service';
import { InMemoryA2pRegistrationStore } from '../../src/integrations/twilio/a2p-10dlc/store';
import { InMemoryQueue } from '../../src/queues/queue';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { tenantContextStore } from '../../src/middleware/tenant-context';

const TENANT = 'tenant-1564';

const body = {
  legalBusinessName: 'Acme Plumbing LLC',
  ein: '12-3456789',
  businessType: 'Limited Liability Corporation',
  businessIndustry: 'CONSTRUCTION',
  websiteUrl: 'https://acme-plumbing.example.com',
  address: { street: '1 Main St', street2: '', city: 'Austin', region: 'tx', postalCode: '78701' },
  contact: { firstName: 'Pat', lastName: 'Owner', email: 'pat@example.com', phone: '(512) 555-0100', title: 'Owner', jobPosition: 'CEO' },
};

function buildApp(role = 'owner') {
  const store = new InMemoryA2pRegistrationStore();
  const queue = new InMemoryQueue();
  const auditRepo = new InMemoryAuditRepository();
  // Every /api route runs inside withTenantTransaction in the app; stand in
  // for it with a request client the service's withTenantClient joins. The
  // pool refuses a checkout, so a job written on a connection of its own fails
  // the request here instead of passing unnoticed.
  const requestClient = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => {
      throw new Error('the request transaction is the only connection');
    }),
  } as unknown as Pool;
  const service = createA2pRegistrationService({ store, queue, auditRepo, encryptionKey: 'c'.repeat(64), pool });
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 's-1',
      tenantId: TENANT,
      role: role as NonNullable<AuthenticatedRequest['auth']>['role'],
    };
    next();
  });
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    tenantContextStore.run({ client: requestClient, tenantId: TENANT }, () => next());
  });
  app.use('/api/settings/texting-registration', createTextingRegistrationRouter({ service }));
  return { app, store, queue, auditRepo, requestClient };
}

describe('/api/settings/texting-registration', () => {
  it('reports not_started before the owner submits anything', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/settings/texting-registration');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'not_started', readiness: 'partial_readiness', details: null, failureReasons: [] });
  });

  it('accepts the owner\'s business details, normalizes them, and never echoes the EIN', async () => {
    const { app, store } = buildApp();

    const put = await request(app).put('/api/settings/texting-registration').send(body);

    expect(put.status).toBe(200);
    expect(put.body.status).toBe('submitted');
    expect(put.body.details).toMatchObject({
      einLast4: '6789',
      address: { street: '1 Main St', street2: null, city: 'Austin', region: 'TX', postalCode: '78701' },
      contact: { phone: '+15125550100' },
    });
    expect(JSON.stringify(put.body)).not.toMatch(/3456789|123456789/);
    expect((await store.get(TENANT))?.einLast4).toBe('6789');

    const get = await request(app).get('/api/settings/texting-registration');
    expect(get.body.status).toBe('submitted');
    expect(JSON.stringify(get.body)).not.toMatch(/3456789|123456789/);
  });

  it('rejects an EIN that is not nine digits', async () => {
    const { app } = buildApp();
    const res = await request(app).put('/api/settings/texting-registration').send({ ...body, ein: '12-34567' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('1234567');
  });

  // The audit row is written before the registration job, so a failed audit
  // write never leaves a job behind (and the job joins the request
  // transaction — test/integration/texting-registration-request-tx.test.ts).
  it('enqueues no registration job when the submission\'s audit write fails', async () => {
    const { app, queue, auditRepo } = buildApp();
    const create = vi.spyOn(auditRepo, 'create').mockRejectedValue(new Error('audit store unavailable'));

    const res = await request(app).put('/api/settings/texting-registration').send(body);

    expect(res.status).toBe(500);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'tenant.a2p_registration_submitted' }));
    expect(await queue.receive()).toBeNull();
  });

  it('enqueues the registration job for an accepted submission on the request transaction', async () => {
    const { app, queue, requestClient } = buildApp();
    const sendOn = vi.spyOn(queue, 'sendOn');

    expect((await request(app).put('/api/settings/texting-registration').send(body)).status).toBe(200);

    expect(sendOn).toHaveBeenCalledTimes(1);
    expect(sendOn).toHaveBeenCalledWith(
      requestClient,
      A2P_REGISTRATION_JOB_TYPE,
      { tenantId: TENANT, poll: 0 },
      expect.stringMatching(new RegExp(`^a2p-10dlc-${TENANT}-\\d+-0$`)),
    );
    const msg = await queue.receive<{ tenantId: string; poll: number }>();
    expect(msg?.type).toBe(A2P_REGISTRATION_JOB_TYPE);
    expect(msg?.payload).toEqual({ tenantId: TENANT, poll: 0 });
  });

  it('refuses a resubmission while the carriers are reviewing it', async () => {
    const { app, store } = buildApp();
    await request(app).put('/api/settings/texting-registration').send(body);
    await store.saveProgress(TENANT, { status: 'brand_pending', refs: { brandSid: 'BNx' }, failureReasons: [] });

    const res = await request(app).put('/api/settings/texting-registration').send(body);
    expect(res.status).toBe(409);
  });

  it('is owner-only for both reading and writing', async () => {
    for (const role of ['dispatcher', 'technician']) {
      const { app } = buildApp(role);
      expect((await request(app).get('/api/settings/texting-registration')).status).toBe(403);
      expect((await request(app).put('/api/settings/texting-registration').send(body)).status).toBe(403);
    }
  });

  it('answers 503 when the server has no encryption key to protect the EIN with', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: 'u', sessionId: 's', tenantId: TENANT, role: 'owner' };
      next();
    });
    app.use('/api/settings/texting-registration', createTextingRegistrationRouter({ service: null }));

    const res = await request(app).put('/api/settings/texting-registration').send(body);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TEXTING_REGISTRATION_NOT_CONFIGURED');
  });
});
