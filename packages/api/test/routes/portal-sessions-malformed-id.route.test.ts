/**
 * Route hardening tests: Portal sessions (#1110, extends the #882 / #1096 sweep)
 *
 * `DELETE /api/portal-sessions/:id` passes `req.params.id` into
 * `PgPortalSessionRepository.revoke`, whose
 * `UPDATE portal_sessions … WHERE tenant_id = $n AND id = $n` compares it
 * against a `uuid` column. A non-UUID id reached Postgres, threw
 * `invalid input syntax for type uuid`, and `asyncRoute` answered a bare
 * `500 INTERNAL_ERROR`.
 *
 * This router gates with a router-level `router.use(requireAuth,
 * requireTenant)` and no per-route permission, so the guard sits directly in
 * front of the handler and the ordering assertions below use the two gates the
 * route actually has (401 unauthenticated, 403 no tenant context).
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
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryPortalSessionRepository } from '../../src/portal/portal-session';
import { createPortalRouter } from '../../src/routes/portal';

const TENANT = 'tenant-portal-malformed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function castUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`invalid input syntax for type uuid: "${value}"`);
  }
}

class PgLikePortalSessionRepository extends InMemoryPortalSessionRepository {
  async findById(tenantId: string, id: string) {
    castUuid(id);
    return super.findById(tenantId, id);
  }

  async revoke(tenantId: string, id: string, at: Date) {
    castUuid(id);
    return super.revoke(tenantId, id, at);
  }
}

function buildApp(
  repo: InMemoryPortalSessionRepository,
  auth: 'owner' | 'no-tenant' | null = 'owner',
): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (auth) {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-portal-malformed',
        sessionId: 'sess-portal-malformed',
        tenantId: auth === 'owner' ? TENANT : '',
        role: 'owner',
      };
    }
    next();
  });
  app.use(
    '/api/portal-sessions',
    createPortalRouter({
      portalRepo: repo,
      customerRepo: new InMemoryCustomerRepository(),
      auditRepo: new InMemoryAuditRepository(),
    }),
  );
  return app;
}

const revoke = (app: Express, id: string) => request(app).delete(`/api/portal-sessions/${id}`);

describe('portal sessions: malformed :id never reaches Postgres as a raw uuid comparison (#1110)', () => {
  let repo: PgLikePortalSessionRepository;

  beforeEach(() => {
    repo = new PgLikePortalSessionRepository();
  });

  it('DELETE /api/portal-sessions/:id with a malformed id answers 404 NOT_FOUND, never a 500', async () => {
    const res = await revoke(buildApp(repo), 'not-a-uuid');
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Portal session not found' });
  });

  it('a well-formed unknown id still answers the identical 404', async () => {
    const res = await revoke(buildApp(repo), uuidv4());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Portal session not found' });
  });

  it('a valid id is unaffected — the session is still revoked', async () => {
    const id = uuidv4();
    await repo.create({
      id,
      tenantId: TENANT,
      customerId: uuidv4(),
      tokenHash: 'hash-portal-malformed',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdBy: 'user-portal-malformed',
      createdAt: new Date(),
    });

    const res = await revoke(buildApp(repo), id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.revokedAt).toBeTruthy();
  });

  it('auth ordering: a caller with no tenant context gets 403 before any existence signal', async () => {
    const res = await revoke(buildApp(repo, 'no-tenant'), 'not-a-uuid');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('auth ordering: an unauthenticated caller with a malformed id gets 401, not 404', async () => {
    const res = await revoke(buildApp(repo, null), 'not-a-uuid');
    expect(res.status).toBe(401);
  });
});
