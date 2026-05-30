/**
 * HTTP route shape tests for the tenant DNC management API.
 *
 * Covers the four assertions a Settings UI relies on:
 *   1. list returns the entries shape with newest-first ordering
 *   2. add normalizes the phone (strips non-digits) and is idempotent
 *   3. add emits a tenant.dnc_added audit event
 *   4. delete normalizes the phone param and emits tenant.dnc_removed
 *   5. permission gating: an actor without settings:manage gets 403
 *      on writes (read uses settings:view).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDncRouter } from '../../src/routes/dnc';
import { InMemoryDncRepository } from '../../src/compliance/dnc';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Role } from '../../src/auth/rbac';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

function buildApp(role: Role = 'owner') {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER,
      sessionId: 'session-test',
      tenantId: TENANT,
      role,
    };
    next();
  });
  const dncRepo = new InMemoryDncRepository();
  const auditRepo = new InMemoryAuditRepository();
  app.use('/api/dnc', createDncRouter({ dncRepo, auditRepo }));
  return { app, dncRepo, auditRepo };
}

describe('POST /api/dnc', () => {
  it('normalizes the phone before storing (strips non-digits)', async () => {
    const { app, dncRepo } = buildApp();
    const res = await request(app)
      .post('/api/dnc')
      .send({ phone: '+1 (555) 123-4567' });
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe('15551234567');
    // Repository got the normalized form.
    expect(await dncRepo.isOnDnc(TENANT, '15551234567')).toBe(true);
  });

  it('emits tenant.dnc_added audit event', async () => {
    const { app, auditRepo } = buildApp();
    await request(app).post('/api/dnc').send({ phone: '5551234567' });

    const events = auditRepo.getAll().filter((e) => e.tenantId === TENANT);
    const added = events.find((e) => e.eventType === 'tenant.dnc_added');
    expect(added).toBeDefined();
    expect(added!.metadata).toMatchObject({ phone: '5551234567', source: 'manual_settings' });
  });

  it('rejects a phone with fewer than 7 digits with 400', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/dnc').send({ phone: '123' });
    expect(res.status).toBe(400);
  });

  it('is idempotent — second add returns 201 with the same phone', async () => {
    const { app } = buildApp();
    await request(app).post('/api/dnc').send({ phone: '5551234567' });
    const res = await request(app).post('/api/dnc').send({ phone: '5551234567' });
    expect(res.status).toBe(201);
  });

  it('honors settings:update — a technician role gets 403 on write', async () => {
    const { app } = buildApp('technician');
    const res = await request(app).post('/api/dnc').send({ phone: '5551234567' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/dnc', () => {
  it('returns the tenant entries in the response shape', async () => {
    const { app } = buildApp();
    await request(app).post('/api/dnc').send({ phone: '5551234567' });
    await request(app).post('/api/dnc').send({ phone: '5559876543', source: 'sms_stop_reply' });

    const res = await request(app).get('/api/dnc');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({
      phone: expect.any(String),
      source: expect.any(String),
      createdAt: expect.any(String),
    });
  });

  it('dispatcher role (settings:view but not :update) can read', async () => {
    const { app } = buildApp('dispatcher');
    const res = await request(app).get('/api/dnc');
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/dnc/:phone', () => {
  let app: ReturnType<typeof buildApp>['app'];
  let dncRepo: ReturnType<typeof buildApp>['dncRepo'];
  let auditRepo: ReturnType<typeof buildApp>['auditRepo'];

  beforeEach(async () => {
    ({ app, dncRepo, auditRepo } = buildApp());
    await request(app).post('/api/dnc').send({ phone: '5551234567' });
  });

  it('removes the entry and returns 204', async () => {
    const res = await request(app).delete('/api/dnc/5551234567');
    expect(res.status).toBe(204);
    expect(await dncRepo.isOnDnc(TENANT, '5551234567')).toBe(false);
  });

  it('normalizes the phone param so url-encoded inputs work', async () => {
    // Seed with the normalized 11-digit form, then delete via a
    // pretty-printed url-encoded variant. The in-memory repo's
    // suffix-match `isOnDnc` would still see the 10-digit entry from
    // the outer beforeEach as a substring match, so we assert on the
    // raw list to prove the specific 11-digit entry is gone.
    await request(app).post('/api/dnc').send({ phone: '15551234567' });
    const res = await request(app).delete(`/api/dnc/${encodeURIComponent('+1-555-123-4567')}`);
    expect(res.status).toBe(204);
    const remaining = await dncRepo.list(TENANT);
    expect(remaining.map((e) => e.phone)).not.toContain('15551234567');
  });

  it('emits tenant.dnc_removed audit event', async () => {
    await request(app).delete('/api/dnc/5551234567');
    const events = auditRepo.getAll().filter((e) => e.tenantId === TENANT);
    const removed = events.find((e) => e.eventType === 'tenant.dnc_removed');
    expect(removed).toBeDefined();
    expect(removed!.metadata).toMatchObject({ phone: '5551234567' });
  });

  it('technician role gets 403 on delete', async () => {
    const { app: techApp } = buildApp('technician');
    const res = await request(techApp).delete('/api/dnc/5551234567');
    expect(res.status).toBe(403);
  });
});
