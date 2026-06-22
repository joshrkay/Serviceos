import { describe, it, expect } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createNotificationPreferencesRouter } from '../../src/routes/notification-preferences';
import { InMemoryNotificationPreferenceRepository } from '../../src/notifications/notification-preferences-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-np-1';
const USER = 'owner-1';

function buildApp() {
  const repo = new InMemoryNotificationPreferenceRepository();
  const auditRepo = new InMemoryAuditRepository();
  const app: Express = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's1', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use('/api/notification-preferences', createNotificationPreferencesRouter(repo, auditRepo));
  return { app, repo, auditRepo };
}

describe('GET /api/notification-preferences', () => {
  it('returns every category default-on for a fresh user', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/notification-preferences');
    expect(res.status).toBe(200);
    expect(res.body.preferences.payment_received).toBe(true);
    expect(res.body.preferences.emergency).toBe(true);
  });
});

describe('PUT /api/notification-preferences', () => {
  it('mutes a category, persists it, and emits an audit event', async () => {
    const { app, repo, auditRepo } = buildApp();
    const res = await request(app)
      .put('/api/notification-preferences')
      .send({ notificationType: 'payment_received', enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.preferences.payment_received).toBe(false);

    const muted = await repo.listMutedUserIds(TENANT, 'payment_received');
    expect(muted.has(USER)).toBe(true);

    const events = await auditRepo.findRecentByTenant!(TENANT, { limit: 10 });
    expect(events.some((e) => e.eventType === 'notification.preferences.updated')).toBe(true);
  });

  it('rejects an unknown notification type', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/notification-preferences')
      .send({ notificationType: 'not_a_type', enabled: false });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean enabled', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/notification-preferences')
      .send({ notificationType: 'payment_received', enabled: 'no' });
    expect(res.status).toBe(400);
  });
});
