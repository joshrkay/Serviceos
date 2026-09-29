/**
 * #1402 §13 — an owner deactivates (never deletes) a teammate.
 *
 * Seam: POST /api/users/:id/deactivate, observed through the same router's
 * GET /api/users roster and the audit repository the router writes to.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createUsersRouter, UsersRouteDeps } from '../../src/routes/users';
import { InMemoryUserRepository } from '../../src/users/user';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-users-deactivate';

describe('POST /api/users/:id/deactivate — #1402 §13', () => {
  let repo: InMemoryUserRepository;
  let audit: InMemoryAuditRepository;
  let ownerId: string;
  let techId: string;

  function buildApp(
    clerkUserId: string,
    role: 'owner' | 'dispatcher' | 'technician',
    deps: UsersRouteDeps = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: clerkUserId,
        sessionId: 'sess-1',
        tenantId: TENANT,
        role,
      };
      next();
    });
    app.use('/api/users', createUsersRouter(repo, deps, audit));
    return app;
  }

  beforeEach(async () => {
    repo = new InMemoryUserRepository();
    audit = new InMemoryAuditRepository();
    ownerId = uuidv4();
    techId = uuidv4();
    await repo.create!({
      id: ownerId, tenantId: TENANT, email: 'owner@example.com',
      role: 'owner', canFieldServe: true, clerkUserId: 'clerk_owner',
    });
    await repo.create!({
      id: techId, tenantId: TENANT, email: 'tech@example.com',
      role: 'technician', canFieldServe: false, clerkUserId: 'clerk_tech',
    });
  });

  it('owner deactivates a technician: 200, roster keeps them but marks them suspended', async () => {
    const app = buildApp('clerk_owner', 'owner');

    const res = await request(app).post(`/api/users/${techId}/deactivate`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: techId, status: 'suspended' });
    const roster = await request(app).get('/api/users');
    const tech = roster.body.data.find((u: { id: string }) => u.id === techId);
    expect(tech).toMatchObject({ email: 'tech@example.com', status: 'suspended' });
  });

  it('records a user.deactivated audit event naming the member and the acting owner', async () => {
    const app = buildApp('clerk_owner', 'owner');

    await request(app).post(`/api/users/${techId}/deactivate`);

    const events = await audit.findByEntity(TENANT, 'user', techId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'user.deactivated',
      actorId: 'clerk_owner',
      actorRole: 'owner',
      metadata: { role: 'technician' },
    });
  });

  it('refuses to let the caller deactivate themself and leaves them active', async () => {
    await repo.create!({
      id: uuidv4(), tenantId: TENANT, email: 'co-owner@example.com',
      role: 'owner', canFieldServe: false, clerkUserId: 'clerk_co_owner',
    });
    const app = buildApp('clerk_owner', 'owner');

    const res = await request(app).post(`/api/users/${ownerId}/deactivate`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('CANNOT_DEACTIVATE_SELF');
    const roster = await request(app).get('/api/users');
    const me = roster.body.data.find((u: { id: string }) => u.id === ownerId);
    expect(me.status ?? 'active').toBe('active');
    expect(await audit.findByEntity(TENANT, 'user', ownerId)).toHaveLength(0);
  });

  it('refuses to deactivate the last active owner', async () => {
    // The only other owner row is suspended, so it cannot act and must not
    // count toward the "another owner exists" guard.
    const soleOwnerId = uuidv4();
    repo = new InMemoryUserRepository();
    await repo.create!({
      id: soleOwnerId, tenantId: TENANT, email: 'sole@example.com',
      role: 'owner', canFieldServe: true, clerkUserId: 'clerk_sole',
    });
    await repo.create!({
      id: uuidv4(), tenantId: TENANT, email: 'suspended-owner@example.com',
      role: 'owner', canFieldServe: false, clerkUserId: 'clerk_suspended',
      status: 'suspended',
    });
    const app = buildApp('clerk_suspended', 'owner');

    const res = await request(app).post(`/api/users/${soleOwnerId}/deactivate`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('LAST_OWNER');
    const roster = await request(app).get('/api/users');
    const sole = roster.body.data.find((u: { id: string }) => u.id === soleOwnerId);
    expect(sole.status ?? 'active').toBe('active');
  });

  it('lets an owner deactivate a co-owner while they remain an active owner', async () => {
    const coOwnerId = uuidv4();
    await repo.create!({
      id: coOwnerId, tenantId: TENANT, email: 'co-owner@example.com',
      role: 'owner', canFieldServe: false, clerkUserId: 'clerk_co_owner',
    });
    const app = buildApp('clerk_owner', 'owner');

    const res = await request(app).post(`/api/users/${coOwnerId}/deactivate`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');
  });

  it('is idempotent: a second deactivation returns 200 and writes no second audit event', async () => {
    const app = buildApp('clerk_owner', 'owner');
    await request(app).post(`/api/users/${techId}/deactivate`);

    const res = await request(app).post(`/api/users/${techId}/deactivate`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('suspended');
    expect(await audit.findByEntity(TENANT, 'user', techId)).toHaveLength(1);
  });

  it('refuses dispatchers (owner-only action)', async () => {
    const app = buildApp('clerk_owner', 'dispatcher');

    const res = await request(app).post(`/api/users/${techId}/deactivate`);

    expect(res.status).toBe(403);
  });

  it('stops push notifications to the deactivated member’s devices', async () => {
    const removeAllForUser = vi.fn().mockResolvedValue(1);
    const app = buildApp('clerk_owner', 'owner', { deviceTokenRepo: { removeAllForUser } });

    await request(app).post(`/api/users/${techId}/deactivate`);

    expect(removeAllForUser).toHaveBeenCalledWith(TENANT, 'clerk_tech');
  });
});
