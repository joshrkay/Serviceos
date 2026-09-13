/**
 * Docker-gated integration test for #1096 — a malformed `:id` on
 * `PATCH /api/users/:id` must never surface as a 500.
 *
 * The route test (test/routes/users-malformed-id.route.test.ts) proves the
 * shape with a PgLike stub. This leg proves it against the real
 * `PgUserRepository` and real Postgres, so the uuid cast that actually throws
 * `invalid input syntax for type uuid` is the one being exercised — per
 * CLAUDE.md, a mocked Pool is never the only proof a query behaves.
 *
 * Pins all three answers on one router instance:
 *   - malformed id            -> 404 NOT_FOUND (not 500)
 *   - well-formed unknown id  -> the same 404 NOT_FOUND
 *   - a real id               -> 200, patch applied (no behaviour change)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgUserRepository } from '../../src/users/pg-user';
import { createUsersRouter } from '../../src/routes/users';
import { AuthenticatedRequest } from '../../src/auth/clerk';

describe('Postgres integration — PATCH /api/users/:id with a malformed id (#1096)', () => {
  let pool: Pool;
  let repo: PgUserRepository;
  let tenant: { tenantId: string; userId: string };
  let targetId: string;

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenant.userId,
        sessionId: 'sess-1096',
        tenantId: tenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/users', createUsersRouter(repo));
    return app;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgUserRepository(pool);
    tenant = await createTestTenant(pool);

    // A second, non-owner row is the PATCH target so the last-owner guard in
    // updateUser() is never what answers.
    targetId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
      [targetId, tenant.tenantId, `clerk-${targetId}`, `tech-${targetId}@example.com`, 'technician'],
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('answers 404 NOT_FOUND for a malformed id — never a 500 from the uuid cast', async () => {
    const res = await request(buildApp())
      .patch('/api/users/not-a-uuid')
      .send({ role: 'dispatcher' });

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'User not found' });
  });

  it('answers the identical 404 for a well-formed id that does not exist', async () => {
    const res = await request(buildApp())
      .patch(`/api/users/${crypto.randomUUID()}`)
      .send({ role: 'dispatcher' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'User not found' });
  });

  it('still applies the patch for a real id (no behaviour change)', async () => {
    const res = await request(buildApp())
      .patch(`/api/users/${targetId}`)
      .send({ role: 'dispatcher' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(targetId);
    expect(res.body.role).toBe('dispatcher');

    const { rows } = await pool.query(`SELECT role FROM users WHERE id = $1`, [targetId]);
    expect(rows[0].role).toBe('dispatcher');
  });
});
