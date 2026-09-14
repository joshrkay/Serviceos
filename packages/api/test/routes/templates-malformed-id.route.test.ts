/**
 * Route hardening tests: Estimate templates (#1110, extends the #882 / #1096 sweep)
 *
 * `GET /api/templates/:id`, `POST /api/templates/:id/instantiate` and
 * `PUT /api/templates/:id` pass `req.params.id` into
 * `PgEstimateTemplateRepository.findById` / `update`, whose
 * `WHERE tenant_id = $n AND id = $n` compares against a `uuid` column. A
 * non-UUID id reached Postgres, threw `invalid input syntax for type uuid`, and
 * `asyncRoute` answered a bare `500 INTERNAL_ERROR`.
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
import { createTemplateRouter } from '../../src/routes/templates';
import {
  EstimateTemplate,
  InMemoryEstimateTemplateRepository,
} from '../../src/templates/estimate-template';

const TENANT = 'tenant-templates-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeEstimateTemplateRepository extends InMemoryEstimateTemplateRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async update(tenantId: string, id: string, updates: Partial<EstimateTemplate>) {
    castUuid(id);
    return super.update(tenantId, id, updates);
  }

  async incrementUsage(tenantId: string, id: string) {
    castUuid(id);
    return super.incrementUsage(tenantId, id);
  }
}

function buildApp(repo: InMemoryEstimateTemplateRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-templates-malformed',
        sessionId: 'sess-templates-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use('/api/templates', createTemplateRouter(repo, new InMemoryAuditRepository()));
  return app;
}

type Send = (app: Express, id: string) => request.Test;

const HANDLERS: Array<{ route: string; send: Send }> = [
  { route: 'GET /api/templates/:id', send: (app, id) => request(app).get(`/api/templates/${id}`) },
  {
    route: 'POST /api/templates/:id/instantiate',
    send: (app, id) => request(app).post(`/api/templates/${id}/instantiate`).send({}),
  },
  {
    route: 'PUT /api/templates/:id',
    send: (app, id) => request(app).put(`/api/templates/${id}`).send({ name: 'Renamed template' }),
  },
];

describe('templates: malformed :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeEstimateTemplateRepository;

  beforeEach(() => {
    repo = new PgLikeEstimateTemplateRepository();
  });

  for (const { route, send } of HANDLERS) {
    it(`${route} with a malformed id answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Template not found' });
    });

    it(`${route} with a well-formed unknown id still answers the identical 404`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Template not found' });
    });
  }

  it('a valid id is unaffected — read, instantiate and update still apply', async () => {
    const id = uuidv4();
    await repo.create({
      id,
      tenantId: TENANT,
      verticalType: 'hvac',
      categoryId: 'cat-1',
      name: 'AC tune-up',
      lineItemTemplates: [],
      defaultDiscountCents: 0,
      defaultTaxRateBps: 0,
      isActive: true,
      usageCount: 0,
      createdBy: 'user-templates-malformed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = buildApp(repo);

    const read = await request(app).get(`/api/templates/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(id);

    const instantiated = await request(app).post(`/api/templates/${id}/instantiate`).send({});
    expect(instantiated.status).toBe(200);

    const updated = await request(app).put(`/api/templates/${id}`).send({ name: 'Renamed template' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Renamed template');
  });

  it('auth ordering: a technician (no estimates:*) gets 403 before any existence signal', async () => {
    const app = buildApp(repo, 'technician');
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    }
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const app = buildApp(repo, null);
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(401);
    }
  });
});
