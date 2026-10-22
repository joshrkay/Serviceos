import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryLsaIntegrationRepository } from '../../src/lsa/lsa-integration';
import { createLsaDispositionReporter } from '../../src/lsa/disposition-reporter';
import { createLsaIntegrationRouter } from '../../src/routes/lsa-integration';

const TENANT = 'tenant-lsa-1';

function build(role: 'owner' | 'dispatcher', over: Partial<Parameters<typeof createLsaIntegrationRouter>[0]> = {}) {
  const integrationRepo = new InMemoryLsaIntegrationRepository();
  const leadRepo = new InMemoryLeadRepository();
  const auditRepo = new InMemoryAuditRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT, role };
    next();
  });
  app.use(
    '/api/lsa-integration',
    createLsaIntegrationRouter({ integrationRepo, leadRepo, auditRepo, publicApiUrl: 'https://api.example.com/', ...over }),
  );
  return { app, integrationRepo, leadRepo, auditRepo };
}

describe('/api/lsa-integration (#1738)', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => {
    ctx = build('owner');
  });

  it('is owner-only', async () => {
    const d = build('dispatcher');
    expect((await request(d.app).get('/api/lsa-integration')).status).toBe(403);
    expect((await request(d.app).post('/api/lsa-integration/link').send({})).status).toBe(403);
    expect((await request(d.app).delete('/api/lsa-integration')).status).toBe(403);
  });

  it('is unlinked (null) by default', async () => {
    const res = await request(ctx.app).get('/api/lsa-integration');
    expect(res.body).toEqual({ data: null });
  });

  it('links, returns the secret once, and never exposes it again', async () => {
    const link = await request(ctx.app).post('/api/lsa-integration/link').send({ accountId: 'acct-1' });
    expect(link.status).toBe(201);
    expect(link.body.data.webhookSecret).toMatch(/^lsa_/);
    expect(link.body.data.webhookUrl).toBe(`https://api.example.com/webhooks/lsa/${TENANT}`);
    expect(link.body.data.autoRespond).toBe(false);

    const get = await request(ctx.app).get('/api/lsa-integration');
    expect(get.body.data.enabled).toBe(true);
    expect(get.body.data.secretHint).toBe(link.body.data.webhookSecret.slice(-4));
    expect(JSON.stringify(get.body)).not.toContain(link.body.data.webhookSecret);

    const types = (await ctx.auditRepo.findByEntity(TENANT, 'lsa_integration', TENANT)).map((e) => e.eventType);
    expect(types).toEqual(['lsa_integration.linked']);
    expect(JSON.stringify(await ctx.auditRepo.findByEntity(TENANT, 'lsa_integration', TENANT))).not.toContain(
      link.body.data.webhookSecret,
    );
  });

  it('re-linking rotates the secret and audits the rotation', async () => {
    const a = await request(ctx.app).post('/api/lsa-integration/link').send({});
    const b = await request(ctx.app).post('/api/lsa-integration/link').send({});
    expect(b.body.data.webhookSecret).not.toBe(a.body.data.webhookSecret);
    const types = (await ctx.auditRepo.findByEntity(TENANT, 'lsa_integration', TENANT)).map((e) => e.eventType);
    expect(types).toEqual(['lsa_integration.linked', 'lsa_integration.secret_rotated']);
  });

  it('503s linking when secrets cannot be stored', async () => {
    const d = build('owner', { canStoreSecrets: false });
    expect((await request(d.app).post('/api/lsa-integration/link').send({})).status).toBe(503);
  });

  it('updates settings, 404s when unlinked, and rejects an empty body', async () => {
    expect((await request(ctx.app).put('/api/lsa-integration').send({ autoRespond: true })).status).toBe(404);
    await request(ctx.app).post('/api/lsa-integration/link').send({});
    const res = await request(ctx.app).put('/api/lsa-integration').send({ autoRespond: true });
    expect(res.body.data.autoRespond).toBe(true);
    expect((await request(ctx.app).put('/api/lsa-integration').send({})).status).toBe(400);
  });

  it('unlinks', async () => {
    await request(ctx.app).post('/api/lsa-integration/link').send({});
    expect((await request(ctx.app).delete('/api/lsa-integration')).body).toEqual({ unlinked: true });
    expect((await request(ctx.app).get('/api/lsa-integration')).body).toEqual({ data: null });
    expect((await request(ctx.app).delete('/api/lsa-integration')).status).toBe(404);
  });

  it('lists recent LSA leads with the lead name and stage', async () => {
    await request(ctx.app).post('/api/lsa-integration/link').send({});
    const lead = await ctx.leadRepo.create({
      id: 'lead-1', tenantId: TENANT, firstName: 'Jane', lastName: 'Doe', source: 'marketplace',
      stage: 'new', createdBy: 'system:lsa', createdAt: new Date(), updatedAt: new Date(),
    });
    await ctx.integrationRepo.recordLead({ tenantId: TENANT, externalLeadId: 'e1', leadId: lead.id, leadType: 'message' });
    const res = await request(ctx.app).get('/api/lsa-integration');
    expect(res.body.data.recentLeads).toEqual([
      expect.objectContaining({ leadId: 'lead-1', name: 'Jane Doe', stage: 'new', leadType: 'message', disposition: null }),
    ]);
  });

  describe('disposition report-back', () => {
    async function seed(c: ReturnType<typeof build>) {
      await request(c.app).post('/api/lsa-integration/link').send({});
      await c.integrationRepo.recordLead({ tenantId: TENANT, externalLeadId: 'e1', leadId: 'lead-1', leadType: 'message' });
    }

    it('records locally and is a no-op to Google when not configured', async () => {
      await seed(ctx);
      const res = await request(ctx.app).post('/api/lsa-integration/leads/lead-1/disposition').send({ disposition: 'booked' });
      expect(res.body.data).toEqual({ leadId: 'lead-1', disposition: 'booked', reportedToGoogle: false });
      expect((await ctx.integrationRepo.listRecent(TENANT, 1))[0]).toMatchObject({ disposition: 'booked' });
    });

    it('reports to the client only when flag + client are both present', async () => {
      const client = { report: vi.fn().mockResolvedValue(undefined) };
      const c = build('owner', { dispositionReporter: createLsaDispositionReporter({ LSA_DISPOSITION_REPORTING_ENABLED: 'true' }, client) });
      await seed(c);
      const res = await request(c.app).post('/api/lsa-integration/leads/lead-1/disposition').send({ disposition: 'spam' });
      expect(res.body.data.reportedToGoogle).toBe(true);
      expect(client.report).toHaveBeenCalledWith({ tenantId: TENANT, externalLeadId: 'e1', disposition: 'spam' });
    });

    it('flag off or client missing => no-op reporter', async () => {
      const client = { report: vi.fn() };
      await createLsaDispositionReporter({}, client).report({ tenantId: 't', externalLeadId: 'e', disposition: 'booked' });
      await createLsaDispositionReporter({ LSA_DISPOSITION_REPORTING_ENABLED: 'true' }).report({ tenantId: 't', externalLeadId: 'e', disposition: 'booked' });
      expect(client.report).not.toHaveBeenCalled();
    });

    it('a failing client does not fail the request', async () => {
      const client = { report: vi.fn().mockRejectedValue(new Error('boom')) };
      const c = build('owner', { dispositionReporter: createLsaDispositionReporter({ LSA_DISPOSITION_REPORTING_ENABLED: 'true' }, client) });
      await seed(c);
      const res = await request(c.app).post('/api/lsa-integration/leads/lead-1/disposition').send({ disposition: 'not_booked' });
      expect(res.status).toBe(200);
      expect(res.body.data.reportedToGoogle).toBe(false);
    });

    it('404s an unknown lead and 400s a bad disposition', async () => {
      await seed(ctx);
      expect((await request(ctx.app).post('/api/lsa-integration/leads/nope/disposition').send({ disposition: 'booked' })).status).toBe(404);
      expect((await request(ctx.app).post('/api/lsa-integration/leads/lead-1/disposition').send({ disposition: 'x' })).status).toBe(400);
    });
  });
});
