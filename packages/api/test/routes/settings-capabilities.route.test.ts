/**
 * #1011 (wayfinder map #995) — the owner-facing per-tenant capability write.
 *
 * Rows 2.6 (vulnerability triage) and 2.7 (dropped-call recovery) are both
 * "Mike/J cannot turn this on": the capabilities exist, are gated per tenant,
 * and only a PLATFORM admin ramping `tenantIds` through
 * `PUT /api/admin/feature-flags/:name` could ever switch them on. This adds the
 * owner half — and nothing more.
 *
 * The load-bearing test in this file is the CONTAINMENT one (D2). A tenant
 * override WINS over the platform flag (pg-tenant-feature-flags.ts:145-147), so
 * without a hard allowlist `settings:update` would become a write to any key in
 * `tenant_feature_flags` — and an owner could set `supervisor_agent=false`
 * (switching off the D-011/U3 default-ON trust mechanism) or
 * `voice_realtime=false`. The allowlist is the whole auth hop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Express } from 'express';
import { createSettingsRouter } from '../../src/routes/settings';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Role } from '../../src/auth/rbac';
import { InMemorySettingsRepository, createSettings } from '../../src/settings/settings';
import {
  InMemoryFeatureFlagRepository,
  type FeatureFlagRepository,
} from '../../src/flags/feature-flags';
import type { TenantCapabilityFlagRepository } from '../../src/routes/settings';

const TENANT = 'tenant-caps-1011';
const OTHER_TENANT = 'tenant-caps-other';
const USER = 'user-caps-1011';

/**
 * Route-level stand-in for `PgTenantFeatureFlagRepository`. Keyed by
 * (tenantId, flagKey) exactly like the table's composite PK, so a write for
 * one tenant cannot be observed by another — the containment the Postgres
 * test proves for real under RLS.
 */
class FakeTenantFlags implements TenantCapabilityFlagRepository {
  readonly rows = new Map<string, { enabled: boolean; updatedBy?: string }>();

  constructor(private readonly platform: FeatureFlagRepository) {}

  private key(tenantId: string, flagKey: string) {
    return `${tenantId}:${flagKey}`;
  }

  async getTenantOverride(tenantId: string, flagKey: string): Promise<boolean | null> {
    const row = this.rows.get(this.key(tenantId, flagKey));
    return row ? row.enabled : null;
  }

  async isEnabledForTenant(tenantId: string, flagKey: string): Promise<boolean> {
    const override = await this.getTenantOverride(tenantId, flagKey);
    if (override !== null) return override;
    const platform = await this.platform.get(flagKey);
    return platform?.enabled ?? false;
  }

  async setTenantFlag(
    tenantId: string,
    flagKey: string,
    enabled: boolean,
    updatedBy?: string,
  ): Promise<void> {
    this.rows.set(this.key(tenantId, flagKey), {
      enabled,
      ...(updatedBy ? { updatedBy } : {}),
    });
  }
}

interface Built {
  app: Express;
  tenantFlags: FakeTenantFlags;
  platformFlags: InMemoryFeatureFlagRepository;
  events: { eventType: string; metadata?: Record<string, unknown>; entityId?: string }[];
}

async function buildApp(opts: { role?: Role; wired?: boolean } = {}): Promise<Built> {
  const role: Role = opts.role ?? 'owner';
  const wired = opts.wired ?? true;

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER,
      sessionId: 'sess-caps',
      tenantId: TENANT,
      role,
    };
    next();
  });

  const settingsRepo = new InMemorySettingsRepository();
  await createSettings({ tenantId: TENANT, businessName: 'Caps Co' }, settingsRepo);

  const platformFlags = new InMemoryFeatureFlagRepository();
  const tenantFlags = new FakeTenantFlags(platformFlags);
  const events: Built['events'] = [];

  app.use(
    '/api/settings',
    createSettingsRouter(
      settingsRepo,
      undefined,
      {
        create: async (e: never) => {
          events.push(e as unknown as Built['events'][number]);
          return e;
        },
      } as never,
      wired ? { tenantFlags, platformFlags } : undefined,
    ),
  );

  return { app, tenantFlags, platformFlags, events };
}

describe('#1011 — PUT /api/settings/capabilities/:key', () => {
  let built: Built;

  beforeEach(async () => {
    built = await buildApp();
  });

  it('owner turns dropped_call_recovery on', async () => {
    const res = await request(built.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: 'dropped_call_recovery',
      enabled: true,
      source: 'tenant',
    });
    expect(built.tenantFlags.rows.get(`${TENANT}:dropped_call_recovery`)).toEqual({
      enabled: true,
      updatedBy: USER,
    });
  });

  it('owner turns voice_vulnerability_triage on', async () => {
    const res = await request(built.app)
      .put('/api/settings/capabilities/voice_vulnerability_triage')
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it('pins updated_by to the acting user so the write has an actor', async () => {
    await request(built.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: true });

    expect(built.tenantFlags.rows.get(`${TENANT}:dropped_call_recovery`)?.updatedBy).toBe(USER);
  });

  it('emits a feature_flag.tenant_updated audit event scoped to the tenant', async () => {
    await request(built.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: true });

    const event = built.events.find((e) => e.eventType === 'feature_flag.tenant_updated');
    expect(event).toBeDefined();
    // `scope` keeps tenant writes distinguishable from the platform-scope rows
    // routes/feature-flags.ts:110-131 writes into the same operator view.
    expect(event!.metadata).toMatchObject({
      scope: 'tenant',
      flagKey: 'dropped_call_recovery',
      value: { enabled: true },
    });
    expect(event!.entityId).toBe('dropped_call_recovery');
  });

  // ── D2 — the allowlist IS the auth hop ───────────────────────────────────

  it('CONTAINMENT (D2): an unlisted key is rejected and NOTHING is written', async () => {
    for (const key of ['supervisor_agent', 'voice_realtime', 'brand_voice_configurator']) {
      const res = await request(built.app)
        .put(`/api/settings/capabilities/${key}`)
        .send({ enabled: false });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNKNOWN_CAPABILITY');
      expect(built.tenantFlags.rows.size).toBe(0);
      expect(built.events).toHaveLength(0);
    }
  });

  it('rejects a non-boolean body without writing', async () => {
    const res = await request(built.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: 'yes' });

    expect(res.status).toBe(400);
    expect(built.tenantFlags.rows.size).toBe(0);
  });

  // ── Tenancy — the caller cannot name the tenant ──────────────────────────

  it('ignores a tenantId in the body or query and writes for req.auth.tenantId', async () => {
    const res = await request(built.app)
      .put(`/api/settings/capabilities/dropped_call_recovery?tenantId=${OTHER_TENANT}`)
      .send({ enabled: true, tenantId: OTHER_TENANT, tenant_id: OTHER_TENANT });

    expect(res.status).toBe(200);
    expect(built.tenantFlags.rows.has(`${TENANT}:dropped_call_recovery`)).toBe(true);
    expect(built.tenantFlags.rows.has(`${OTHER_TENANT}:dropped_call_recovery`)).toBe(false);
  });

  // ── D5 — the platform floor ──────────────────────────────────────────────

  it('D5: refuses with 409 when a platform flag freezes the capability off', async () => {
    await built.platformFlags.upsert({ name: 'dropped_call_recovery', enabled: false });

    const res = await request(built.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('PLATFORM_DISABLED');
    expect(built.tenantFlags.rows.size).toBe(0);
    expect(built.events).toHaveLength(0);
  });

  it('D5: a platform flag that is ON does not block the owner write', async () => {
    await built.platformFlags.upsert({ name: 'dropped_call_recovery', enabled: true });

    const res = await request(built.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: true });

    expect(res.status).toBe(200);
  });

  it('D5: the platform floor also blocks an owner turning the capability OFF', async () => {
    // Not a loophole to leave open: the floor is "the platform owns this key
    // right now", not "the platform owns the true value".
    await built.platformFlags.upsert({ name: 'dropped_call_recovery', enabled: false });

    const res = await request(built.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: false });

    expect(res.status).toBe(409);
    expect(built.tenantFlags.rows.size).toBe(0);
  });

  // ── Permissions ──────────────────────────────────────────────────────────

  it('dispatcher (settings:view but not settings:update) gets 403', async () => {
    const dispatcher = await buildApp({ role: 'dispatcher' });
    const res = await request(dispatcher.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: true });

    expect(res.status).toBe(403);
    expect(dispatcher.tenantFlags.rows.size).toBe(0);
  });

  it('technician gets 403', async () => {
    const tech = await buildApp({ role: 'technician' });
    const res = await request(tech.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: true });

    expect(res.status).toBe(403);
  });

  // ── Unwired (in-memory) boot ─────────────────────────────────────────────

  it('503s rather than pretending, when no tenant-flag repository is wired', async () => {
    const unwired = await buildApp({ wired: false });
    const res = await request(unwired.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: true });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('CAPABILITIES_NOT_CONFIGURED');
  });
});

describe('#1011 — GET /api/settings/capabilities', () => {
  it('reads both capabilities back with their resolved state and source', async () => {
    const built = await buildApp();
    await request(built.app)
      .put('/api/settings/capabilities/dropped_call_recovery')
      .send({ enabled: true });

    const res = await request(built.app).get('/api/settings/capabilities');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dropped_call_recovery: { enabled: true, source: 'tenant' },
      voice_vulnerability_triage: { enabled: false, source: 'default' },
    });
  });

  it('reports a platform-sourced value as platform, not tenant', async () => {
    const built = await buildApp();
    await built.platformFlags.upsert({ name: 'voice_vulnerability_triage', enabled: true });

    const res = await request(built.app).get('/api/settings/capabilities');

    expect(res.status).toBe(200);
    expect(res.body.voice_vulnerability_triage).toEqual({ enabled: true, source: 'platform' });
  });

  it('is readable by a dispatcher (settings:view)', async () => {
    const dispatcher = await buildApp({ role: 'dispatcher' });
    const res = await request(dispatcher.app).get('/api/settings/capabilities');
    expect(res.status).toBe(200);
  });

  it('503s when no tenant-flag repository is wired', async () => {
    const unwired = await buildApp({ wired: false });
    const res = await request(unwired.app).get('/api/settings/capabilities');
    expect(res.status).toBe(503);
  });
});
