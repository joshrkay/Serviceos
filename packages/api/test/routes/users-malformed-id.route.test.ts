/**
 * Route hardening tests: Users (#1096, extends the #882 sweep)
 *
 * `PATCH /api/users/:id` passes `req.params.id` straight into
 * `updateUser -> PgUserRepository.update`, whose `WHERE tenant_id = $n AND
 * id = $n` compares against a `uuid` column. A non-UUID id therefore reached
 * Postgres, threw `invalid input syntax for type uuid`, and the route's
 * catch-all answered a bare `500 INTERNAL_ERROR` (#1096).
 *
 * `InMemoryUserRepository` is a plain Map so it cannot reproduce that on its
 * own; the PgLike subclass below throws exactly what Postgres would, the
 * pattern established by customers.route.test.ts (#871) and
 * leads.route.test.ts (#882).
 *
 * Expected answer is the route's own 404 NOT_FOUND envelope, matching the
 * nine sibling routers already guarded by `notFoundOnMalformedId`
 * (src/middleware/validate-uuid-param.ts): a malformed id can never name a
 * resource, and 404 keeps the answer identical to an unknown-but-well-formed
 * id so the id format is not leaked.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createUsersRouter } from '../../src/routes/users';
import { InMemoryUserRepository, UpdateUserInput } from '../../src/users/user';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-users-malformed';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class PgLikeUserRepository extends InMemoryUserRepository {
  async findById(tenantId: string, id: string) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.findById(tenantId, id);
  }

  async update(tenantId: string, id: string, updates: UpdateUserInput) {
    if (!UUID_RE.test(id)) {
      throw new Error(`invalid input syntax for type uuid: "${id}"`);
    }
    return super.update(tenantId, id, updates);
  }
}

function buildApp(repo: InMemoryUserRepository) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'clerk-owner',
      sessionId: 'sess-1',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/users', createUsersRouter(repo));
  return app;
}

describe('malformed :id never reaches Postgres as a raw uuid comparison (#1096)', () => {
  let repo: PgLikeUserRepository;
  let existingId: string;

  beforeEach(async () => {
    repo = new PgLikeUserRepository();
    existingId = uuidv4();
    await repo.create!({
      id: existingId,
      tenantId: TENANT,
      email: 'owner@example.com',
      role: 'owner',
      canFieldServe: true,
      clerkUserId: 'clerk-owner',
    });
    await repo.create!({
      id: uuidv4(),
      tenantId: TENANT,
      email: 'second-owner@example.com',
      role: 'owner',
      canFieldServe: true,
      clerkUserId: 'clerk-owner-2',
    });
  });

  it('PATCH /api/users/not-a-uuid returns 404 NOT_FOUND, never a 500', async () => {
    const res = await request(buildApp(repo))
      .patch('/api/users/not-a-uuid')
      .send({ role: 'dispatcher' });

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'User not found' });
  });

  it('a well-formed but unknown uuid still answers the ordinary 404', async () => {
    const res = await request(buildApp(repo))
      .patch(`/api/users/${uuidv4()}`)
      .send({ role: 'dispatcher' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'User not found' });
  });

  it('a valid id is unaffected — the patch still applies', async () => {
    const res = await request(buildApp(repo))
      .patch(`/api/users/${existingId}`)
      .send({ role: 'dispatcher' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(existingId);
    expect(res.body.role).toBe('dispatcher');
  });
});
