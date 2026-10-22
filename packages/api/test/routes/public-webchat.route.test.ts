/**
 * #1737 — the public web chat HTTP surface and the owner's settings router,
 * over the real service with a scripted gateway.
 */
import request from 'supertest';
import express, { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicWebchatRouter } from '../../src/routes/public-webchat';
import { createWebchatSettingsRouter } from '../../src/routes/webchat-settings';
import { createWebchatService } from '../../src/webchat/webchat-service';
import { InMemoryWebchatConfigRepository } from '../../src/webchat/webchat-config';
import { InMemoryWebchatUsageRepository } from '../../src/webchat/webchat-usage';
import { createVoiceTurnProcessor } from '../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import type { LLMGateway } from '../../src/ai/gateway/gateway';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://rivera-hvac.example.com';
const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function setup(flag = true) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const configRepo = new InMemoryWebchatConfigRepository();
  const usageRepo = new InMemoryWebchatUsageRepository();
  const auditRepo = new InMemoryAuditRepository();
  const leadRepo = new InMemoryLeadRepository();
  const settingsRepo = new InMemorySettingsRepository();
  await settingsRepo.create({ tenantId: TENANT, businessName: 'Rivera HVAC' } as unknown as TenantSettings);
  const gateway = {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} }),
      model: 'm', provider: 'm', tokenUsage: { input: 1, output: 1, total: 2 }, latencyMs: 1,
    })),
  } as unknown as LLMGateway;
  const isEnabledForTenant = async () => flag;
  const service = createWebchatService({
    configRepo, usageRepo, settingsRepo, store, auditRepo, leadRepo, isEnabledForTenant,
    globallyKilled: () => false,
    processorFor: (businessName) =>
      createVoiceTurnProcessor({
        store, gateway, businessName, systemActorId: 'system:webchat', auditRepo,
        proposalRepo: new InMemoryProposalRepository(), customerRepo: new InMemoryCustomerRepository(),
        leadRepo, settingsRepo,
      }),
    bookingUrlFor: (id) => `https://app.example.com/book?t=${id}`,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/public/webchat', createPublicWebchatRouter({ service }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: 'u1', sessionId: 's1', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/webchat',
    createWebchatSettingsRouter({
      configRepo, usageRepo, auditRepo, apiBaseUrl: 'https://api.example.com', isEnabledForTenant,
      globallyKilled: () => false,
    }),
  );
  return { app, configRepo, auditRepo, leadRepo };
}

/** What the widget sends: a text/plain body that carries JSON (no CORS preflight). */
const post = (app: express.Express, path: string, body: unknown, origin = ORIGIN) =>
  request(app).post(`/api/public/webchat${path}`).set('Origin', origin).set('Content-Type', 'text/plain;charset=UTF-8').send(JSON.stringify(body));

describe('GET /api/public/webchat/widget.js', () => {
  it('serves the script cross-origin-loadable and cacheable', async () => {
    const { app } = await setup();
    const res = await request(app).get('/api/public/webchat/widget.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.text).toContain('data-token');
  });
});

describe('public chat flow', () => {
  it('is unavailable until the owner turns it on; then start → message → handoff → end works', async () => {
    const { app, configRepo, leadRepo } = await setup();
    const cfg = await configRepo.upsert(TENANT, { allowedOrigins: [ORIGIN] });

    const off = await post(app, '/session', { token: cfg.embedToken });
    expect(off.status).toBe(404);
    expect(off.body.error).toBe('UNAVAILABLE');

    await configRepo.upsert(TENANT, { enabled: true });
    const started = await post(app, '/session', { token: cfg.embedToken });
    expect(started.status).toBe(201);
    expect(started.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(started.headers['access-control-allow-credentials']).toBeUndefined();
    const { sessionId } = started.body;

    const msg = await post(app, '/message', { token: cfg.embedToken, sessionId, text: 'hello there' });
    expect(msg.status).toBe(200);
    expect(msg.body.replies.length).toBeGreaterThan(0);

    const hand = await post(app, '/handoff', {
      token: cfg.embedToken, sessionId, name: 'Pat', phone: '+15555550123', requestOwner: false,
    });
    expect(hand.status).toBe(201);
    expect(hand.body.bookingUrl).toContain('/book?t=');
    expect(hand.body.leadId).toBeUndefined();
    expect(await leadRepo.findByTenant(TENANT)).toHaveLength(1);

    expect((await post(app, '/end', { token: cfg.embedToken, sessionId })).status).toBe(200);
    expect((await post(app, '/message', { token: cfg.embedToken, sessionId, text: 'hi' })).status).toBe(404);
  });

  it('403s a site that is not on the allow-list and 400s a malformed body', async () => {
    const { app, configRepo } = await setup();
    const cfg = await configRepo.upsert(TENANT, { enabled: true, allowedOrigins: [ORIGIN] });
    expect((await post(app, '/session', { token: cfg.embedToken }, 'https://evil.example')).status).toBe(403);
    expect((await post(app, '/message', { token: cfg.embedToken, sessionId: 'not-a-uuid', text: 'x' })).status).toBe(400);
    const bad = await request(app).post('/api/public/webchat/session').set('Origin', ORIGIN).set('Content-Type', 'text/plain').send('{oops');
    expect(bad.status).toBe(400);
  });

  it('is unavailable when the platform flag is off even if the owner enabled it', async () => {
    const { app, configRepo } = await setup(false);
    const cfg = await configRepo.upsert(TENANT, { enabled: true, allowedOrigins: [ORIGIN] });
    expect((await post(app, '/session', { token: cfg.embedToken })).status).toBe(404);
  });
});

describe('/api/webchat (owner settings)', () => {
  it('starts off with no snippet, then saving sites mints one; toggling is audited', async () => {
    const { app, auditRepo } = await setup();
    const first = await request(app).get('/api/webchat');
    expect(first.body.data).toMatchObject({ enabled: false, snippet: null, allowedOrigins: [], available: true });

    const saved = await request(app).put('/api/webchat').send({ allowedOrigins: ['https://Rivera-HVAC.example.com/'] });
    expect(saved.status).toBe(200);
    expect(saved.body.data.allowedOrigins).toEqual([ORIGIN]);
    expect(saved.body.data.snippet).toMatch(/^<script async src="https:\/\/api\.example\.com\/api\/public\/webchat\/widget\.js" data-token="[0-9a-f-]{36}\.[0-9a-f]{24}"><\/script>$/);

    const on = await request(app).put('/api/webchat').send({ enabled: true, dailyTurnCap: 50, dailyCostCapCents: 200 });
    expect(on.body.data).toMatchObject({ enabled: true, dailyTurnCap: 50, dailyCostCapCents: 200 });
    const events = (await auditRepo.findByEntity(TENANT, 'webchat_config', TENANT)).map((e) => e.eventType);
    expect(events).toEqual(['webchat.config_updated', 'webchat.config_updated']);
  });

  it('refuses to enable with no allowed site, a bad site, or caps out of range', async () => {
    const { app } = await setup();
    expect((await request(app).put('/api/webchat').send({ enabled: true })).status).toBe(400);
    expect((await request(app).put('/api/webchat').send({ allowedOrigins: ['not a site'] })).status).toBe(400);
    expect((await request(app).put('/api/webchat').send({ dailyTurnCap: 0 })).status).toBe(400);
    expect((await request(app).put('/api/webchat').send({ dailyCostCapCents: 1.5 })).status).toBe(400);
    expect((await request(app).put('/api/webchat').send({ unknown: true })).status).toBe(400);
  });

  it('refuses to enable when the platform flag is off for the tenant', async () => {
    const { app } = await setup(false);
    await request(app).put('/api/webchat').send({ allowedOrigins: [ORIGIN] });
    const res = await request(app).put('/api/webchat').send({ enabled: true });
    expect(res.status).toBe(400);
    expect((await request(app).get('/api/webchat')).body.data.available).toBe(false);
  });

  it('rotating the token invalidates the old snippet', async () => {
    const { app } = await setup();
    const before = (await request(app).put('/api/webchat').send({ allowedOrigins: [ORIGIN] })).body.data.snippet;
    const after = (await request(app).post('/api/webchat/rotate-token')).body.data.snippet;
    expect(after).not.toBe(before);
  });

  it('the kill switch stops chats immediately', async () => {
    const { app, configRepo } = await setup();
    const cfg = await configRepo.upsert(TENANT, { enabled: true, allowedOrigins: [ORIGIN] });
    expect((await post(app, '/session', { token: cfg.embedToken })).status).toBe(201);
    await request(app).put('/api/webchat').send({ killed: true });
    expect((await post(app, '/session', { token: cfg.embedToken })).status).toBe(404);
  });
});
