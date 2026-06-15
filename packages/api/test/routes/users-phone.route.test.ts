import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createUsersRouter } from '../../src/routes/users';
import { InMemoryUserRepository } from '../../src/users/user';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { AuditRepository, AuditEvent } from '../../src/audit/audit';

const TENANT = 'tenant-phone-route';

function auditStub() {
  const created: AuditEvent[] = [];
  const repo = {
    create: vi.fn(async (e: AuditEvent) => {
      created.push(e);
      return e;
    }),
  } as unknown as AuditRepository;
  return { repo, created };
}

function buildApp(
  repo: InMemoryUserRepository,
  auth: { userId: string; role: 'owner' | 'dispatcher' | 'technician' },
  auditRepo?: AuditRepository,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: auth.userId,
      sessionId: 'sess-1',
      tenantId: TENANT,
      role: auth.role,
    };
    next();
  });
  app.use('/api/users', createUsersRouter(repo, {}, auditRepo));
  return app;
}

async function seedUser(
  repo: InMemoryUserRepository,
  id: string,
  role: 'owner' | 'dispatcher' | 'technician',
  email: string,
) {
  await repo.create!({
    id,
    tenantId: TENANT,
    email,
    role,
    canFieldServe: role === 'technician',
    clerkUserId: `clerk_${id}`,
  });
}

describe('PUT /api/users/:id/phone — self-service escalation number', () => {
  let repo: InMemoryUserRepository;
  let techId: string;
  let ownerId: string;

  beforeEach(async () => {
    repo = new InMemoryUserRepository();
    techId = uuidv4();
    ownerId = uuidv4();
    await seedUser(repo, techId, 'technician', 'tech@example.com');
    await seedUser(repo, ownerId, 'owner', 'owner@example.com');
  });

  it('lets a technician set their OWN number via me, normalized to E.164, with PII-safe audit', async () => {
    const audit = auditStub();
    const app = buildApp(repo, { userId: techId, role: 'technician' }, audit.repo);

    const res = await request(app)
      .put('/api/users/me/phone')
      .send({ mobileNumber: '(512) 555-0199' });

    expect(res.status).toBe(200);
    expect(res.body.mobileNumber).toBe('+15125550199');
    const found = await repo.findById(TENANT, techId);
    expect(found!.mobileNumber).toBe('+15125550199');

    expect(audit.repo.create).toHaveBeenCalledTimes(1);
    expect(audit.created[0].eventType).toBe('user.mobile_number.updated');
    // never log the digits
    expect(JSON.stringify(audit.created[0].metadata)).not.toContain('5550199');
  });

  it('lets a technician set their own number by explicit id', async () => {
    const app = buildApp(repo, { userId: techId, role: 'technician' });
    const res = await request(app).put(`/api/users/${techId}/phone`).send({ mobileNumber: '5125550111' });
    expect(res.status).toBe(200);
    expect(res.body.mobileNumber).toBe('+15125550111');
  });

  it("forbids a technician setting another user's number (403)", async () => {
    const app = buildApp(repo, { userId: techId, role: 'technician' });
    const res = await request(app).put(`/api/users/${ownerId}/phone`).send({ mobileNumber: '5125550111' });
    expect(res.status).toBe(403);
  });

  it("lets an owner set a teammate's number", async () => {
    const app = buildApp(repo, { userId: ownerId, role: 'owner' });
    const res = await request(app).put(`/api/users/${techId}/phone`).send({ mobileNumber: '5125550111' });
    expect(res.status).toBe(200);
    expect(res.body.mobileNumber).toBe('+15125550111');
  });

  it('clears the number on null', async () => {
    await repo.setMobileNumber(TENANT, techId, '+15125550111');
    const app = buildApp(repo, { userId: techId, role: 'technician' });
    const res = await request(app).put('/api/users/me/phone').send({ mobileNumber: null });
    expect(res.status).toBe(200);
    expect(res.body.mobileNumber == null).toBe(true);
  });

  it('rejects an invalid number with 400', async () => {
    const app = buildApp(repo, { userId: techId, role: 'technician' });
    const res = await request(app).put('/api/users/me/phone').send({ mobileNumber: 'not-a-phone' });
    expect(res.status).toBe(400);
  });

  it('returns 409 when the number is already taken by another teammate', async () => {
    await repo.setMobileNumber(TENANT, ownerId, '+15125550111');
    const app = buildApp(repo, { userId: techId, role: 'technician' });
    const res = await request(app).put('/api/users/me/phone').send({ mobileNumber: '5125550111' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/users/:id/phone — read the current escalation number', () => {
  let repo: InMemoryUserRepository;
  let techId: string;
  let ownerId: string;

  beforeEach(async () => {
    repo = new InMemoryUserRepository();
    techId = uuidv4();
    ownerId = uuidv4();
    await seedUser(repo, techId, 'technician', 'tech@example.com');
    await seedUser(repo, ownerId, 'owner', 'owner@example.com');
    await repo.setMobileNumber(TENANT, techId, '+15125550111');
  });

  it("returns the caller's own number via me", async () => {
    const app = buildApp(repo, { userId: techId, role: 'technician' });
    const res = await request(app).get('/api/users/me/phone');
    expect(res.status).toBe(200);
    expect(res.body.mobileNumber).toBe('+15125550111');
  });

  it('returns null when the caller has no number set', async () => {
    const app = buildApp(repo, { userId: ownerId, role: 'owner' });
    const res = await request(app).get('/api/users/me/phone');
    expect(res.status).toBe(200);
    expect(res.body.mobileNumber).toBeNull();
  });

  it("forbids a technician reading another user's number (403)", async () => {
    const app = buildApp(repo, { userId: techId, role: 'technician' });
    const res = await request(app).get(`/api/users/${ownerId}/phone`);
    expect(res.status).toBe(403);
  });
});
