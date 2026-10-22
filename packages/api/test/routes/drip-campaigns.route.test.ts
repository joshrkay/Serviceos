/**
 * #1735 — owner-only, flag-gated drip campaign API.
 * Seam: the mounted router over the in-memory repository.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { createDripCampaignsRouter } from '../../src/routes/drip-campaigns';
import { InMemoryDripRepository } from '../../src/marketing/drip/drip-repository';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = '11111111-1111-4111-8111-111111111111';

const validBody = {
  name: 'Win back',
  targetKind: 'lapsed_customers',
  steps: [
    { channel: 'sms', delayMinutes: 0, body: 'Hi {{firstName}}' },
    { channel: 'call', delayMinutes: 1440, agentPhone: '+15551234567' },
  ],
};

function buildApp(opts: { role?: string; enabled?: boolean } = {}) {
  const repo = new InMemoryDripRepository();
  const auditRepo = new InMemoryAuditRepository();
  const enrollTargets = vi.fn(async () => 3);
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 's-1',
      tenantId: TENANT,
      role: (opts.role ?? 'owner') as NonNullable<AuthenticatedRequest['auth']>['role'],
    };
    next();
  });
  app.use(
    '/api/drip-campaigns',
    createDripCampaignsRouter({
      repo,
      engine: { enrollTargets },
      isEnabledForTenant: async () => opts.enabled ?? true,
      auditRepo,
    }),
  );
  return { app, repo, auditRepo, enrollTargets };
}

describe('/api/drip-campaigns', () => {
  it('is off by default: every route but /status is 404 without the flag', async () => {
    const { app } = buildApp({ enabled: false });
    expect((await request(app).get('/api/drip-campaigns/status')).body).toEqual({ enabled: false });
    expect((await request(app).get('/api/drip-campaigns/sequences')).status).toBe(404);
    expect((await request(app).post('/api/drip-campaigns/sequences').send(validBody)).status).toBe(404);
  });

  it('is owner-only', async () => {
    for (const role of ['dispatcher', 'technician']) {
      const { app } = buildApp({ role });
      expect((await request(app).get('/api/drip-campaigns/status')).status).toBe(403);
      expect((await request(app).get('/api/drip-campaigns/sequences')).status).toBe(403);
      expect((await request(app).post('/api/drip-campaigns/sequences').send(validBody)).status).toBe(403);
    }
  });

  it('creates a paused sequence, audits it, and lists it with stats', async () => {
    const { app, auditRepo } = buildApp();
    const created = await request(app).post('/api/drip-campaigns/sequences').send(validBody);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'paused', targetDays: 180, name: 'Win back' });

    const list = await request(app).get('/api/drip-campaigns/sequences');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].stats).toEqual({ sequenceId: created.body.id, enrolled: 0, active: 0, completed: 0, booked: 0 });
    expect((await auditRepo.findRecentByTenant(TENANT)).map((e) => e.eventType)).toContain('drip.sequence_created');
  });

  it('rejects an invalid sequence', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/drip-campaigns/sequences')
      .send({ ...validBody, steps: [{ channel: 'call', delayMinutes: 0, agentPhone: 'nope' }] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('resumes and pauses, and 404s an unknown or malformed id', async () => {
    const { app, auditRepo } = buildApp();
    const { body } = await request(app).post('/api/drip-campaigns/sequences').send(validBody);
    const resumed = await request(app).post(`/api/drip-campaigns/sequences/${body.id}/resume`);
    expect(resumed.body.status).toBe('active');
    const paused = await request(app).post(`/api/drip-campaigns/sequences/${body.id}/pause`);
    expect(paused.body.status).toBe('paused');
    const types = (await auditRepo.findRecentByTenant(TENANT)).map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['drip.sequence_resumed', 'drip.sequence_paused']));

    const unknown = '99999999-9999-4999-8999-999999999999';
    expect((await request(app).post(`/api/drip-campaigns/sequences/${unknown}/pause`)).status).toBe(404);
    expect((await request(app).post('/api/drip-campaigns/sequences/not-a-uuid/pause')).status).toBe(404);
  });

  it('enrolls targets through the engine', async () => {
    const { app, enrollTargets } = buildApp();
    const { body } = await request(app).post('/api/drip-campaigns/sequences').send(validBody);
    const res = await request(app).post(`/api/drip-campaigns/sequences/${body.id}/enroll`);
    expect(res.body).toEqual({ enrolled: 3 });
    expect(enrollTargets).toHaveBeenCalledWith(TENANT, body.id, { userId: 'user-1', role: 'owner' });
  });
});
