import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createUsersRouter } from '../../src/routes/users';
import { InMemoryUserRepository } from '../../src/users/user';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-users-route';

function buildApp(repo: InMemoryUserRepository, role: 'owner' | 'dispatcher' | 'technician' = 'owner') {
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
  app.use('/api/users', createUsersRouter(repo));
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
