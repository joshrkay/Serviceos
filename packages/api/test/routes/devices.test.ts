import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDevicesRouter } from '../../src/routes/devices';
import { InMemoryDeviceTokenRepository } from '../../src/devices/device-token-repository';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = 'user_123';

function makeApp(opts: { withAuth?: boolean } = {}) {
  const withAuth = opts.withAuth !== false;
  const deviceTokenRepo = new InMemoryDeviceTokenRepository();
  const auditRepo = new InMemoryAuditRepository();
  const app = express();
  app.use(express.json());
  if (withAuth) {
    app.use((req, _res, next) => {
      // Stub the Clerk auth middleware: requireAuth/requireTenant only read req.auth.
      (req as unknown as { auth: unknown }).auth = { userId: USER, tenantId: TENANT, role: 'owner' };
      next();
    });
  }
  app.use('/api/devices', createDevicesRouter({ deviceTokenRepo, auditRepo }));
  return { app, deviceTokenRepo, auditRepo };
}

describe('devices route', () => {
  it('registers a device and emits an audit event', async () => {
    const { app, deviceTokenRepo, auditRepo } = makeApp();
    const res = await request(app).post('/api/devices').send({ platform: 'ios', token: 'tok-1' });
    expect(res.status).toBe(201);
    expect(res.body.platform).toBe('ios');
    expect(await deviceTokenRepo.listByTenant(TENANT)).toHaveLength(1);
    const events = auditRepo.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('device.registered');
    expect(events[0].actorId).toBe(USER);
  });

  it('rejects an invalid platform with 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/devices').send({ platform: 'web', token: 't' });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const { app } = makeApp({ withAuth: false });
    const res = await request(app).post('/api/devices').send({ platform: 'ios', token: 't' });
    expect(res.status).toBe(401);
  });

  it('unregisters a token (204) and 404 when absent', async () => {
    const { app, deviceTokenRepo, auditRepo } = makeApp();
    await deviceTokenRepo.register({ tenantId: TENANT, userId: USER, platform: 'ios', token: 'tok-1' });
    const ok = await request(app).delete('/api/devices/tok-1');
    expect(ok.status).toBe(204);
    expect(await deviceTokenRepo.listByTenant(TENANT)).toHaveLength(0);
    const missing = await request(app).delete('/api/devices/nope');
    expect(missing.status).toBe(404);
    expect(auditRepo.getAll().some((e) => e.eventType === 'device.unregistered')).toBe(true);
  });
});
