import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createUsersRouter, UsersRouteDeps } from '../../src/routes/users';
import { InMemoryUserRepository } from '../../src/users/user';
import { InMemoryPendingInvitationRepository } from '../../src/users/pending-invitation';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-users-route';

function buildApp(
  repo: InMemoryUserRepository,
  role: 'owner' | 'dispatcher' | 'technician' = 'owner',
  deps: UsersRouteDeps = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-test',
      sessionId: 'sess-1',
      tenantId: TENANT,
      role,
    };
    next();
  });
  app.use('/api/users', createUsersRouter(repo, deps));
  return app;
}

describe('GET /api/users — Tier 4 Team members (PR 1)', () => {
  let repo: InMemoryUserRepository;
  beforeEach(async () => {
    repo = new InMemoryUserRepository();
    const now = new Date();
    await repo.create!({
      id: uuidv4(), tenantId: TENANT, email: 'a@example.com',
      role: 'owner', canFieldServe: true, clerkUserId: 'clerk_a',
    });
    await repo.create!({
      id: uuidv4(), tenantId: TENANT, email: 'b@example.com',
      role: 'technician', canFieldServe: false, clerkUserId: 'clerk_b',
    });
    void now;
  });

  it('returns { data: User[] } for the calling tenant', async () => {
    const app = buildApp(repo);
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
    const emails = res.body.data.map((u: { email: string }) => u.email).sort();
    expect(emails).toEqual(['a@example.com', 'b@example.com']);
  });

  it('filters by ?role=technician', async () => {
    const app = buildApp(repo);
    const res = await request(app).get('/api/users?role=technician');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].role).toBe('technician');
  });

  it('ignores an invalid ?role value (returns all)', async () => {
    const app = buildApp(repo);
    const res = await request(app).get('/api/users?role=admin');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('rejects technicians without the users:list permission', async () => {
    const app = buildApp(repo, 'technician');
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/users/:id — Tier 4 Team members (PR 2)', () => {
  let repo: InMemoryUserRepository;
  let ownerId: string;
  let techId: string;

  beforeEach(async () => {
    repo = new InMemoryUserRepository();
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
    // A second owner so demotion tests aren't blocked by the
    // last-owner guard unless they want to be.
    await repo.create!({
      id: uuidv4(), tenantId: TENANT, email: 'co-owner@example.com',
      role: 'owner', canFieldServe: false, clerkUserId: 'clerk_co_owner',
    });
  });

  it('owner can change a teammate role and the response carries the new role', async () => {
    const app = buildApp(repo, 'owner');
    const res = await request(app)
      .patch(`/api/users/${techId}`)
      .send({ role: 'dispatcher' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('dispatcher');
  });

  it('rejects unknown role values at the schema layer', async () => {
    const app = buildApp(repo, 'owner');
    const res = await request(app)
      .patch(`/api/users/${techId}`)
      .send({ role: 'admin' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the user does not exist in the tenant', async () => {
    const app = buildApp(repo, 'owner');
    const res = await request(app)
      .patch(`/api/users/${uuidv4()}`)
      .send({ role: 'technician' });
    expect(res.status).toBe(404);
  });

  it('rejects dispatchers without users:edit_role', async () => {
    const app = buildApp(repo, 'dispatcher');
    const res = await request(app)
      .patch(`/api/users/${techId}`)
      .send({ role: 'dispatcher' });
    expect(res.status).toBe(403);
  });

  it('refuses to demote the last owner', async () => {
    const onlyOwnerRepo = new InMemoryUserRepository();
    const id = uuidv4();
    await onlyOwnerRepo.create!({
      id, tenantId: TENANT, email: 'solo@example.com',
      role: 'owner', canFieldServe: true, clerkUserId: 'clerk_solo',
    });
    const app = buildApp(onlyOwnerRepo, 'owner');
    const res = await request(app)
      .patch(`/api/users/${id}`)
      .send({ role: 'dispatcher' });
    expect(res.status).toBe(400);
    expect(res.body.message ?? '').toMatch(/only owner/i);
  });
});

describe('POST/GET /api/users/invitations — Tier 4 Team members (PR 3)', () => {
  let userRepo: InMemoryUserRepository;
  let inviteRepo: InMemoryPendingInvitationRepository;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    inviteRepo = new InMemoryPendingInvitationRepository();
  });

  function jsonOk(body: unknown): Response {
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => body, text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  it('owner POST creates an invitation (no Clerk configured)', async () => {
    const app = buildApp(userRepo, 'owner', { pendingInvitationRepo: inviteRepo });
    const res = await request(app)
      .post('/api/users/invitations')
      .send({ email: 'New@Example.COM', role: 'technician' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('new@example.com');
    expect(res.body.role).toBe('technician');
    expect(res.body.tenantId).toBe(TENANT);
    expect(res.body.clerkInvitationId).toBeNull();

    const list = await inviteRepo.findByTenant(TENANT);
    expect(list).toHaveLength(1);
  });

  it('POST calls the Clerk API when configured and persists the returned id', async () => {
    const clerkFetch = vi.fn(async () =>
      jsonOk({ id: 'inv_clerk_xyz', status: 'pending' }),
    );
    const app = buildApp(userRepo, 'owner', {
      pendingInvitationRepo: inviteRepo,
      clerkSecretKey: 'sk_test_xxx',
      clerkFetch,
      appBaseUrl: 'https://app.example.com',
    });

    const res = await request(app)
      .post('/api/users/invitations')
      .send({ email: 'jane@example.com', role: 'dispatcher' });

    expect(res.status).toBe(201);
    expect(res.body.clerkInvitationId).toBe('inv_clerk_xyz');
    expect(clerkFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((clerkFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.email_address).toBe('jane@example.com');
    expect(body.public_metadata.tenant_id).toBe(TENANT);
    expect(body.public_metadata.role).toBe('dispatcher');
  });

  it('POST persists the local row even when the Clerk call fails (best-effort)', async () => {
    const clerkFetch = vi.fn(async () => {
      throw new Error('clerk down');
    });
    const app = buildApp(userRepo, 'owner', {
      pendingInvitationRepo: inviteRepo,
      clerkSecretKey: 'sk_test_xxx',
      clerkFetch,
    });

    const res = await request(app)
      .post('/api/users/invitations')
      .send({ email: 'jane@example.com', role: 'technician' });

    expect(res.status).toBe(201);
    expect(res.body.clerkInvitationId).toBeNull();
    const list = await inviteRepo.findByTenant(TENANT);
    expect(list).toHaveLength(1);
  });

  it('rejects a duplicate pending invitation with 400', async () => {
    const app = buildApp(userRepo, 'owner', { pendingInvitationRepo: inviteRepo });
    await request(app).post('/api/users/invitations')
      .send({ email: 'jane@example.com', role: 'technician' });
    const res = await request(app).post('/api/users/invitations')
      .send({ email: 'jane@example.com', role: 'dispatcher' });
    expect(res.status).toBe(400);
    expect(res.body.message ?? '').toMatch(/already exists/i);
  });

  it('rejects malformed email at the Zod layer', async () => {
    const app = buildApp(userRepo, 'owner', { pendingInvitationRepo: inviteRepo });
    const res = await request(app).post('/api/users/invitations')
      .send({ email: 'not-an-email', role: 'technician' });
    expect(res.status).toBe(400);
  });

  it('rejects dispatchers without users:invite (RBAC)', async () => {
    const app = buildApp(userRepo, 'dispatcher', { pendingInvitationRepo: inviteRepo });
    const res = await request(app).post('/api/users/invitations')
      .send({ email: 'jane@example.com', role: 'technician' });
    expect(res.status).toBe(403);
  });

  it('GET returns pending invitations for the tenant', async () => {
    await inviteRepo.create({
      tenantId: TENANT, email: 'jane@example.com',
      role: 'technician', invitedBy: 'user-owner',
    });
    const app = buildApp(userRepo, 'owner', { pendingInvitationRepo: inviteRepo });
    const res = await request(app).get('/api/users/invitations');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].email).toBe('jane@example.com');
  });

  it('GET returns empty array when the repo is not wired (legacy harness)', async () => {
    const app = buildApp(userRepo, 'owner');
    const res = await request(app).get('/api/users/invitations');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
