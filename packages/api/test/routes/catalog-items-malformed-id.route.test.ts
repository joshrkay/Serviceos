/**
 * Route hardening tests: Catalog items (#1110, extends the #882 / #1096 sweep)
 *
 * `PUT /api/catalog/items/:id` and `DELETE /api/catalog/items/:id` pass
 * `req.params.id` straight into `PgCatalogItemRepository.update/archive`,
 * whose `WHERE tenant_id = $n AND id = $n` compares against a `uuid` column.
 * A non-UUID id reached Postgres, threw `invalid input syntax for type uuid`,
 * and `asyncRoute` answered a bare `500 INTERNAL_ERROR`.
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
import {
  InMemoryCatalogItemRepository,
  UpdateCatalogItemInput,
  createCatalogItem,
} from '../../src/catalog/catalog-item';
import { createCatalogItemsRouter } from '../../src/routes/catalog-items';

const TENANT = 'tenant-catalog-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeCatalogItemRepository extends InMemoryCatalogItemRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async update(tenantId: string, id: string, updates: UpdateCatalogItemInput) {
    castUuid(id);
    return super.update(tenantId, id, updates);
  }

  async archive(tenantId: string, id: string) {
    castUuid(id);
    return super.archive(tenantId, id);
  }
}

function buildApp(repo: InMemoryCatalogItemRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-catalog-malformed',
        sessionId: 'sess-catalog-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use('/api/catalog/items', createCatalogItemsRouter(repo, new InMemoryAuditRepository()));
  return app;
}

type Send = (app: Express, id: string) => request.Test;

const HANDLERS: Array<{ route: string; send: Send }> = [
  {
    route: 'PUT /api/catalog/items/:id',
    send: (app, id) => request(app).put(`/api/catalog/items/${id}`).send({ name: 'Renamed' }),
  },
  {
    route: 'DELETE /api/catalog/items/:id',
    send: (app, id) => request(app).delete(`/api/catalog/items/${id}`),
  },
];

describe('catalog items: malformed :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeCatalogItemRepository;

  beforeEach(() => {
    repo = new PgLikeCatalogItemRepository();
  });

  for (const { route, send } of HANDLERS) {
    it(`${route} with a malformed id answers 404 NOT_FOUND, never a 500`, async () => {
      const res = await send(buildApp(repo), 'not-a-uuid');
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Catalog item not found' });
    });

    it(`${route} with a well-formed unknown id still answers the identical 404`, async () => {
      const res = await send(buildApp(repo), uuidv4());
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Catalog item not found' });
    });
  }

  it('a valid id is unaffected — update and archive still apply', async () => {
    const item = await repo.create(
      createCatalogItem({
        tenantId: TENANT,
        name: 'Filter',
        category: 'Parts',
        unit: 'each',
        unitPriceCents: 1500,
      }),
    );
    const app = buildApp(repo);

    const updated = await request(app).put(`/api/catalog/items/${item.id}`).send({ name: 'Renamed' });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Renamed');

    const archived = await request(app).delete(`/api/catalog/items/${item.id}`);
    expect(archived.status).toBe(204);
  });

  it('auth ordering: a technician (no settings:update) gets 403 before any existence signal', async () => {
    const app = buildApp(repo, 'technician');
    for (const { send } of HANDLERS) {
      const res = await send(app, 'not-a-uuid');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    }
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const res = await request(buildApp(repo, null)).delete('/api/catalog/items/not-a-uuid');
    expect(res.status).toBe(401);
  });
});
