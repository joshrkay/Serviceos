/**
 * Route hardening tests: Service bundles (#1110, extends the #882 / #1096 sweep)
 *
 * `GET /api/bundles/:id` and `PUT /api/bundles/:id` pass `req.params.id`
 * straight into `PgServiceBundleRepository`, whose `WHERE tenant_id = $n AND
 * id = $n` compares against a `uuid` column. A non-UUID id reached Postgres,
 * threw `invalid input syntax for type uuid`, and `asyncRoute` answered a bare
 * `500 INTERNAL_ERROR`.
 *
 * The PgLike subclass throws exactly what Postgres would (pattern:
 * users-malformed-id.route.test.ts); the real-Postgres leg is
 * test/integration/malformed-id-404-seam.test.ts.
 */
import express, { Request, Response, NextFunction, type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createBundleRouter } from '../../src/routes/bundles';
import { InMemoryServiceBundleRepository, ServiceBundle } from '../../src/verticals/bundles';

const TENANT = 'tenant-bundles-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeServiceBundleRepository extends InMemoryServiceBundleRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async update(tenantId: string, id: string, updates: Partial<ServiceBundle>) {
    castUuid(id);
    return super.update(tenantId, id, updates);
  }
}

function buildApp(repo: InMemoryServiceBundleRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-bundles-malformed',
        sessionId: 'sess-bundles-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use('/api/bundles', createBundleRouter(repo, new InMemoryAuditRepository()));
  return app;
}

type Send = (app: Express, id: string) => request.Test;

const HANDLERS: Array<{ route: string; send: Send }> = [
  { route: 'GET /api/bundles/:id', send: (app, id) => request(app).get(`/api/bundles/${id}`) },
  {
    route: 'PUT /api/bundles/:id',
    send: (app, id) => request(app).put(`/api/bundles/${id}`).send({ name: 'Renamed bundle' }),
  },
];

describe('bundles: malformed :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeServiceBundleRepository;

  beforeEach(() => {
    repo = new PgLikeServiceBundleRepository();
  });

  for (const { route, send } of HANDLERS) {
    it(`${route} with a malformed id answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Bundle not found' });
    });

    it(`${route} with a well-formed unknown id still answers the identical 404`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Bundle not found' });
    });
  }

  it('a valid id is unaffected — read and update still apply', async () => {
    const id = uuidv4();
    await repo.create({
      id,
      tenantId: TENANT,
      verticalType: 'hvac',
      name: 'AC tune-up',
      categoryIds: ['cat-1'],
      lineItemTemplates: [],
      triggerKeywords: ['tune-up'],
      isActive: true,
      usageCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildApp(repo);

    const read = await request(app).get(`/api/bundles/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(id);

    const updated = await request(app).put(`/api/bundles/${id}`).send({ name: 'Renamed bundle' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Renamed bundle');
  });

  it('auth ordering: a technician (no estimates:view / estimates:update) gets 403 before any existence signal', async () => {
    const app = buildApp(repo, 'technician');
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    }
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const res = await request(buildApp(repo, null)).get('/api/bundles/not-a-uuid');
    expect(res.status).toBe(401);
  });
});
