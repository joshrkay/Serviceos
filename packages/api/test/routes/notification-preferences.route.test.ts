import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createNotificationPreferencesRouter } from '../../src/routes/notification-preferences';
import { InMemoryNotificationPreferenceRepository } from '../../src/notifications/notification-preferences-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const AUTH = { userId: 'user-1', tenantId: 'tenant-1', role: 'owner' as const };

function buildApp(
  repo: InMemoryNotificationPreferenceRepository,
  auditRepo: InMemoryAuditRepository,
): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { auth: typeof AUTH }).auth = AUTH;
    next();
  });
  app.use('/api/notification-preferences', createNotificationPreferencesRouter(repo, auditRepo));
  return app;
}

describe('notification-preferences route (U10)', () => {
  let repo: InMemoryNotificationPreferenceRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: Express;

  beforeEach(() => {
    repo = new InMemoryNotificationPreferenceRepository();
    auditRepo = new InMemoryAuditRepository();
    app = buildApp(repo, auditRepo);
  });

  it('GET returns every type defaulting to enabled', async () => {
    const res = await request(app).get('/api/notification-preferences');
    expect(res.status).toBe(200);
    expect(res.body.preferences.incoming_call).toBe(true);
    expect(res.body.preferences.payment_received).toBe(true);
  });

  it('PUT mutes a category, persists it, and emits an audit event', async () => {
    const res = await request(app)
      .put('/api/notification-preferences')
      .send({ notificationType: 'inbound_sms', enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.preferences.inbound_sms).toBe(false);
    expect(res.body.preferences.incoming_call).toBe(true);

    const muted = await repo.listMutedUserIds('tenant-1', 'inbound_sms');
    expect(muted.has('user-1')).toBe(true);

    const audits = auditRepo.getAll();
    expect(audits.some((a) => a.eventType === 'notification.preferences.updated')).toBe(true);
  });

  it('PUT rejects an unknown notification type', async () => {
    const res = await request(app)
      .put('/api/notification-preferences')
      .send({ notificationType: 'not_a_type', enabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('PUT rejects a non-boolean enabled', async () => {
    const res = await request(app)
      .put('/api/notification-preferences')
      .send({ notificationType: 'inbound_sms', enabled: 'nope' });
    expect(res.status).toBe(400);
  });
});
