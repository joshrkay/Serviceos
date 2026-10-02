/**
 * #1564 — owner-only API for the A2P 10DLC texting registration
 * (Settings → Phone: submit the business details, read the status).
 *
 * Seam: the mounted router (GET / PUT /api/settings/texting-registration)
 * over the real service + in-memory store.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect } from 'vitest';
import { createTextingRegistrationRouter } from '../../src/routes/texting-registration';
import { createA2pRegistrationService } from '../../src/integrations/twilio/a2p-10dlc/service';
import { InMemoryA2pRegistrationStore } from '../../src/integrations/twilio/a2p-10dlc/store';
import { InMemoryQueue } from '../../src/queues/queue';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

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
  const service = createA2pRegistrationService({ store, queue, auditRepo, encryptionKey: 'c'.repeat(64) });
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
  app.use('/api/settings/texting-registration', createTextingRegistrationRouter({ service }));
  return { app, store, queue };
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
