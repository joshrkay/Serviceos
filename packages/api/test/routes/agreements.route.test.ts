/**
 * Route hardening tests: Agreements (#882)
 *
 * A non-UUID `:id` used to flow straight into PgAgreementRepository's uuid
 * comparison, so Postgres threw `invalid input syntax for type uuid` and the
 * route answered a bare 500. This PgLike subclass throws the same error
 * Postgres would (pattern: customers.route.test.ts, the #871 precedent).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Express, NextFunction, Request, Response } from 'express';
import { createAgreementsRouter } from '../../src/routes/agreements';
import { InMemoryAgreementRepository, type Agreement } from '../../src/agreements/agreement';
import { InMemoryAgreementRunRepository } from '../../src/agreements/agreement-run';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = 'tenant-agreements-1';
const USER_ID = 'user-agreements-1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PgLikeAgreementRepository extends InMemoryAgreementRepository {
  async findById(tenantId: string, id: string) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.findById(tenantId, id);
  }

  async update(tenantId: string, id: string, updates: Partial<Agreement>) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.update(tenantId, id, updates);
  }
}

function buildPgLikeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-agreements-1',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/agreements',
    createAgreementsRouter({
      agreementRepo: new PgLikeAgreementRepository(),
      runRepo: new InMemoryAgreementRunRepository(),
      auditRepo: new InMemoryAuditRepository(),
      jobsService: { createJob: async () => ({ id: 'job-1' }) },
      invoicesService: { createDraftInvoice: async () => ({ id: 'inv-1' }) },
    }),
  );
  return app;
}

describe('malformed :id never reaches Postgres as a raw uuid comparison (#882)', () => {
  let app: Express;

  beforeEach(() => {
    app = buildPgLikeApp();
  });

  it('GET /api/agreements/not-a-uuid returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).get('/api/agreements/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.message).toBe('Agreement not found');
  });

  it('PATCH /api/agreements/not-a-uuid returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).patch('/api/agreements/not-a-uuid').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/agreements/not-a-uuid/pause returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).post('/api/agreements/not-a-uuid/pause').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/agreements/not-a-uuid/resume returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).post('/api/agreements/not-a-uuid/resume').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/agreements/not-a-uuid/cancel returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).post('/api/agreements/not-a-uuid/cancel').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/agreements/not-a-uuid/run-now returns 404 NOT_FOUND, not 500 (owner)', async () => {
    const res = await request(app).post('/api/agreements/not-a-uuid/run-now').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('a well-formed but unknown uuid still answers the ordinary 404', async () => {
    const res = await request(app).get('/api/agreements/11111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
