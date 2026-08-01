/**
 * P12-001 — `/api/me` and `POST /api/me/mode` route tests.
 *
 * Covers the four contract points the story calls out:
 *  - `GET /api/me` returns the right shape (includes role, permissions,
 *    mode, can_field_serve, tenant settings);
 *  - `POST /api/me/mode` accepts `tech` for an `owner`;
 *  - rejects `tech` for a `dispatcher` with `can_field_serve = false`;
 *  - accepts `tech` for a `dispatcher` with `can_field_serve = true`;
 *  - emits exactly one `mode_switched` audit row per accepted switch.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMeRouter,
  InMemoryUserModeService,
} from '../../src/routes/me';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import {
  clearUserModeCacheForTests,
  setUserModeLoader,
} from '../../src/middleware/auth';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { getPermissions } from '../../src/auth/rbac';

const TENANT = '11111111-1111-1111-1111-111111111111';

interface FakeAuth {
  userId: string;
  role: 'owner' | 'dispatcher' | 'technician';
}

function buildApp(
  fakeAuth: FakeAuth,
  meOptions?: Parameters<typeof createMeRouter>[2],
) {
  const service = new InMemoryUserModeService();
  const audit = new InMemoryAuditRepository();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).auth = {
      userId: fakeAuth.userId,
      sessionId: 'sess-test',
      tenantId: TENANT,
      role: fakeAuth.role,
    };
    next();
  });
  app.use('/api/me', createMeRouter(service, audit, meOptions));
  return { app, service, audit };
}

describe('P12-001 — /api/me', () => {
  beforeEach(() => {
    setUserModeLoader(null);
    clearUserModeCacheForTests();
  });

  it('GET /api/me returns user_id, tenant_id, role, mode, permissions, settings', async () => {
    const { app, service } = buildApp({ userId: 'user-owner', role: 'owner' });
    service.upsertUser({
      user_id: 'user-owner',
      tenant_id: TENANT,
      role: 'owner',
      can_field_serve: true,
      current_mode: 'supervisor',
      mode_changed_at: null,
    });
    service.setTenantSettings(TENANT, {
      backup_supervisor_user_id: null,
      unsupervised_proposal_routing: 'queue_and_sms',
    });

    const res = await request(app).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user_id: 'user-owner',
      tenant_id: TENANT,
      role: 'owner',
      can_field_serve: true,
      current_mode: 'supervisor',
      mode_changed_at: null,
      backup_supervisor_user_id: null,
      unsupervised_proposal_routing: 'queue_and_sms',
      integration_statuses: [],
    });
    // Permissions sourced from rbac.ts — read-only verification.
    expect(Array.isArray(res.body.permissions)).toBe(true);
    expect(res.body.permissions).toEqual(getPermissions('owner'));
  });

  // N-011 — the brand-voice flag resolver is tenant-aware and may be async
  // (tenant override → platform flag). /api/me must AWAIT it so a per-tenant
  // dark launch actually surfaces `brand_voice_configurator_enabled: true`.
  it('GET /api/me awaits an async brand-voice resolver (tenant override enabled)', async () => {
    const seen: string[] = [];
    const { app, service } = buildApp(
      { userId: 'user-owner', role: 'owner' },
      {
        isBrandVoiceConfiguratorEnabled: async (tenantId: string) => {
          seen.push(tenantId);
          return Promise.resolve(true);
        },
      },
    );
    service.setTenantSettings(TENANT, {
      backup_supervisor_user_id: null,
      unsupervised_proposal_routing: 'queue_and_sms',
    });
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(200);
    // Awaited to the resolved boolean, not a pending Promise (which would
    // serialize to {}), and the resolver was called with the tenant id.
    expect(res.body.brand_voice_configurator_enabled).toBe(true);
    expect(seen).toEqual([TENANT]);
  });

  it('GET /api/me brand_voice_configurator_enabled is false when the resolver says so or is absent', async () => {
    const off = buildApp(
      { userId: 'user-owner', role: 'owner' },
      { isBrandVoiceConfiguratorEnabled: async () => false },
    );
    off.service.setTenantSettings(TENANT, {
      backup_supervisor_user_id: null,
      unsupervised_proposal_routing: 'queue_and_sms',
    });
    const resOff = await request(off.app).get('/api/me');
    expect(resOff.body.brand_voice_configurator_enabled).toBe(false);

    const absent = buildApp({ userId: 'user-owner', role: 'owner' });
    absent.service.setTenantSettings(TENANT, {
      backup_supervisor_user_id: null,
      unsupervised_proposal_routing: 'queue_and_sms',
    });
    const resAbsent = await request(absent.app).get('/api/me');
    expect(resAbsent.body.brand_voice_configurator_enabled).toBe(false);
  });

  // Sweep-2 S5 — /api/me additively exposes the internal users.id UUID.
  // `user_id` is the AUTH identity (Clerk sub, non-UUID in production);
  // appointment assignments store users.id, so technician surfaces need
  // this field to resolve "which technician am I".
  it('GET /api/me returns internal_user_id when the users row carries one', async () => {
    const { app, service } = buildApp({ userId: 'user_2clerkSub', role: 'technician' });
    service.upsertUser({
      user_id: 'user_2clerkSub',
      internal_user_id: '7e0d3f0a-2b1c-4a5d-9e8f-3c6b7a1d2e4f',
      tenant_id: TENANT,
      role: 'technician',
      can_field_serve: true,
      current_mode: 'tech',
      mode_changed_at: null,
    });

    const res = await request(app).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe('user_2clerkSub');
    expect(res.body.internal_user_id).toBe('7e0d3f0a-2b1c-4a5d-9e8f-3c6b7a1d2e4f');
  });

  it('GET /api/me returns internal_user_id: null when no users row exists (no technician mapping)', async () => {
    const { app } = buildApp({ userId: 'user_demo_owner', role: 'owner' });
    // No upsertUser — fresh tenant / dev-bypass principal.
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.internal_user_id).toBeNull();
  });

  it("POST /api/me/mode accepts 'tech' for an owner and writes an audit row", async () => {
    const { app, service, audit } = buildApp({
      userId: 'user-owner',
      role: 'owner',
    });
    service.upsertUser({
      user_id: 'user-owner',
      tenant_id: TENANT,
      role: 'owner',
      can_field_serve: true,
      current_mode: 'supervisor',
      mode_changed_at: null,
    });

    const res = await request(app).post('/api/me/mode').send({ mode: 'tech' });
    expect(res.status).toBe(204);

    const u = await service.getUser(TENANT, 'user-owner');
    expect(u?.current_mode).toBe('tech');

    const events = audit.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('mode_switched');
    expect(events[0].entityType).toBe('user');
    expect(events[0].entityId).toBe('user-owner');
    expect(events[0].metadata).toMatchObject({
      from_mode: 'supervisor',
      to_mode: 'tech',
    });
  });

  it("POST /api/me/mode rejects 'tech' for a dispatcher with can_field_serve=false", async () => {
    const { app, service, audit } = buildApp({
      userId: 'user-disp',
      role: 'dispatcher',
    });
    service.upsertUser({
      user_id: 'user-disp',
      tenant_id: TENANT,
      role: 'dispatcher',
      can_field_serve: false,
      current_mode: 'supervisor',
      mode_changed_at: null,
    });

    const res = await request(app).post('/api/me/mode').send({ mode: 'tech' });
    expect(res.status).toBe(403);
    const u = await service.getUser(TENANT, 'user-disp');
    expect(u?.current_mode).toBe('supervisor');
    expect(audit.getAll()).toHaveLength(0);
  });

  it("POST /api/me/mode accepts 'tech' for a dispatcher with can_field_serve=true", async () => {
    const { app, service, audit } = buildApp({
      userId: 'user-disp-fs',
      role: 'dispatcher',
    });
    service.upsertUser({
      user_id: 'user-disp-fs',
      tenant_id: TENANT,
      role: 'dispatcher',
      can_field_serve: true,
      current_mode: 'supervisor',
      mode_changed_at: null,
    });

    const res = await request(app).post('/api/me/mode').send({ mode: 'tech' });
    expect(res.status).toBe(204);
    const u = await service.getUser(TENANT, 'user-disp-fs');
    expect(u?.current_mode).toBe('tech');
    expect(audit.getAll()).toHaveLength(1);
    expect(audit.getAll()[0].metadata).toMatchObject({
      from_mode: 'supervisor',
      to_mode: 'tech',
    });
  });

  it('POST /api/me/mode rejects an invalid mode value with 400', async () => {
    const { app, audit } = buildApp({ userId: 'user-owner', role: 'owner' });
    const res = await request(app)
      .post('/api/me/mode')
      .send({ mode: 'unsupervised' }); // not in {supervisor, tech, both}
    expect(res.status).toBe(400);
    expect(audit.getAll()).toHaveLength(0);
  });

  it('POST /api/me/mode emits exactly one audit row per accepted switch', async () => {
    const { app, service, audit } = buildApp({
      userId: 'user-owner',
      role: 'owner',
    });
    service.upsertUser({
      user_id: 'user-owner',
      tenant_id: TENANT,
      role: 'owner',
      can_field_serve: true,
      current_mode: 'supervisor',
      mode_changed_at: null,
    });
    await request(app).post('/api/me/mode').send({ mode: 'tech' });
    await request(app).post('/api/me/mode').send({ mode: 'both' });
    await request(app).post('/api/me/mode').send({ mode: 'supervisor' });
    expect(audit.getAll()).toHaveLength(3);
    expect(audit.getAll().map((e) => e.metadata?.to_mode)).toEqual([
      'tech',
      'both',
      'supervisor',
    ]);
  });
});
