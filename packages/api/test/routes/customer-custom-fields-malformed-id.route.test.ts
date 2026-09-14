/**
 * Route hardening tests: Customer custom-field definitions (#1110, extends the
 * #882 / #1096 sweep)
 *
 * `POST /api/customer-custom-fields/:fieldDefId/archive` passes
 * `req.params.fieldDefId` straight into `PgCustomFieldRepository.archiveDef`,
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
import { InMemoryCustomFieldRepository } from '../../src/customers/custom-field';
import { createCustomerCustomFieldRouter } from '../../src/routes/customer-custom-fields';

const TENANT = 'tenant-custom-fields-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikeCustomFieldRepository extends InMemoryCustomFieldRepository {
  async findDefById(tenantId: string, id: string) {
    castUuid(id);
    return super.findDefById(tenantId, id);
  }

  async archiveDef(tenantId: string, id: string) {
    castUuid(id);
    return super.archiveDef(tenantId, id);
  }
}

function buildApp(repo: InMemoryCustomFieldRepository, role: string | null = 'owner'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-custom-fields-malformed',
        sessionId: 'sess-custom-fields-malformed',
        tenantId: TENANT,
        role,
      };
    }
    next();
  });
  app.use(
    '/api/customer-custom-fields',
    createCustomerCustomFieldRouter(repo, new InMemoryAuditRepository()),
  );
  return app;
}

const archive = (app: Express, id: string) =>
  request(app).post(`/api/customer-custom-fields/${id}/archive`).send({});

describe('customer custom fields: malformed :fieldDefId never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikeCustomFieldRepository;

  beforeEach(() => {
    repo = new PgLikeCustomFieldRepository();
  });

  it('POST /api/customer-custom-fields/:fieldDefId/archive with a malformed id answers 404 NOT_FOUND, never a 500', async () => {
    const res = await archive(buildApp(repo), 'not-a-uuid');
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Custom field not found' });
  });

  it('a well-formed unknown id still answers the identical 404', async () => {
    const res = await archive(buildApp(repo), uuidv4());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Custom field not found' });
  });

  it('a valid id is unaffected — the definition is still archived', async () => {
    const id = uuidv4();
    await repo.createDef({
      id,
      tenantId: TENANT,
      key: 'gate_code',
      label: 'Gate code',
      fieldType: 'text',
      options: [],
      sortOrder: 0,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await archive(buildApp(repo), id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.isArchived).toBe(true);
  });

  it('auth ordering: a technician (no customers:update) gets 403 before any existence signal', async () => {
    const res = await archive(buildApp(repo, 'technician'), 'not-a-uuid');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const res = await archive(buildApp(repo, null), 'not-a-uuid');
    expect(res.status).toBe(401);
  });
});
