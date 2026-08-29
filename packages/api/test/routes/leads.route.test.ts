/**
 * Route hardening tests: Leads (#882)
 *
 * A non-UUID `:id` used to flow straight into PgLeadRepository's
 * `WHERE tenant_id = $1 AND id = $2` uuid comparison, so Postgres threw
 * `invalid input syntax for type uuid` and the route answered a bare 500.
 * `InMemoryLeadRepository` is a plain Map so it can't reproduce that by
 * itself; this PgLike subclass throws the same error Postgres would
 * (pattern: customers.route.test.ts, the #871 precedent).
 *
 * The fix (`notFoundOnMalformedId`, src/middleware/validate-uuid-param.ts)
 * answers the route's own 404 envelope before the repository is called.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Express, NextFunction, Request, Response } from 'express';
import { createLeadsRouter } from '../../src/routes/leads';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import type { Lead } from '../../src/leads/lead';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = 'tenant-leads-1';
const USER_ID = 'user-leads-1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PgLikeLeadRepository extends InMemoryLeadRepository {
  async findById(tenantId: string, id: string) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.findById(tenantId, id);
  }

  async update(tenantId: string, id: string, updates: Partial<Lead>) {
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
      sessionId: 'session-leads-1',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/leads',
    createLeadsRouter(
      new PgLikeLeadRepository(),
      new InMemoryCustomerRepository(),
      new InMemoryAuditRepository(),
      new InMemoryLocationRepository(),
    ),
  );
  return app;
}

describe('malformed :id never reaches Postgres as a raw uuid comparison (#882)', () => {
  let app: Express;

  beforeEach(() => {
    app = buildPgLikeApp();
  });

  it('GET /api/leads/not-a-uuid returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).get('/api/leads/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(res.body.message).toBe('Lead not found');
  });

  it('PATCH /api/leads/not-a-uuid returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).patch('/api/leads/not-a-uuid').send({ firstName: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/leads/not-a-uuid/convert returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app).post('/api/leads/not-a-uuid/convert').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /api/leads/not-a-uuid/lose returns 404 NOT_FOUND, not 500', async () => {
    const res = await request(app)
      .post('/api/leads/not-a-uuid/lose')
      .send({ reason: 'went with a competitor' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('a well-formed but unknown uuid still answers the ordinary 404', async () => {
    const res = await request(app).get('/api/leads/11111111-1111-1111-1111-111111111111');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });
});
