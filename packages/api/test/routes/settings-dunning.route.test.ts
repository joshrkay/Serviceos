/**
 * #1143 (row 8.10) — `GET` / `PUT /api/settings/dunning`, the owner's write
 * path for the tenant's late-fee policy.
 *
 * `DunningConfigRepository.upsert` had no product caller, so every tenant ran
 * `defaultDunningConfig()` (`lateFeeType: 'none'`) and the overdue sweep could
 * never propose `apply_late_fee`. These route-level cases pin the contract
 * (permission split, validation, preservation of the reminder cadence, audit);
 * test/integration/dunning-config-owner-write.test.ts proves the write reaches
 * Postgres and the real sweep charges it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Express } from 'express';
import { createSettingsRouter } from '../../src/routes/settings';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Role } from '../../src/auth/rbac';
import { InMemorySettingsRepository, createSettings } from '../../src/settings/settings';
import {
  InMemoryDunningConfigRepository,
  defaultDunningConfig,
} from '../../src/invoices/dunning-config';

const TENANT = 'tenant-dunning-1143';
const OTHER_TENANT = 'tenant-dunning-other';
const USER = 'user_2dunningOwner';

interface Built {
  app: Express;
  repo: InMemoryDunningConfigRepository;
  events: { eventType: string; entityType?: string; metadata?: Record<string, unknown> }[];
}

async function buildApp(opts: { role?: Role; wired?: boolean } = {}): Promise<Built> {
  const role: Role = opts.role ?? 'owner';
  const wired = opts.wired ?? true;

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 'sess-1143', tenantId: TENANT, role };
    next();
  });

  const settingsRepo = new InMemorySettingsRepository();
  await createSettings({ tenantId: TENANT, businessName: 'Dunning Co' }, settingsRepo);
  const repo = new InMemoryDunningConfigRepository();
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
      undefined,
      wired ? { dunningConfigRepo: repo } : undefined,
    ),
  );
  return { app, repo, events };
}

describe('#1143 — GET /api/settings/dunning', () => {
  it('returns the default policy (no late fee) with configured:false when the tenant has no row', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/settings/dunning');
    expect(res.status).toBe(200);
    const d = defaultDunningConfig(TENANT);
    expect(res.body).toEqual({
      configured: false,
      enabled: d.enabled,
      reminderSteps: d.reminderSteps,
      lateFeeType: 'none',
      lateFeeValueCents: 0,
      lateFeeGraceDays: 0,
      lateFeeMaxCents: null,
    });
  });

  it('is readable with settings:view (dispatcher) but not by a technician', async () => {
    expect((await request((await buildApp({ role: 'dispatcher' })).app).get('/api/settings/dunning')).status).toBe(200);
    expect((await request((await buildApp({ role: 'technician' })).app).get('/api/settings/dunning')).status).toBe(403);
  });

  it('503s when no dunning repository is wired (never a shape that reads as "no late fee")', async () => {
    const res = await request((await buildApp({ wired: false })).app).get('/api/settings/dunning');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DUNNING_NOT_CONFIGURED');
  });
});

describe('#1143 — PUT /api/settings/dunning', () => {
  let built: Built;

  beforeEach(async () => {
    built = await buildApp();
  });

  it('owner sets a capped flat fee; the stored row keeps the default reminder cadence; GET reflects it', async () => {
    const res = await request(built.app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'flat', lateFeeValueCents: 2500, lateFeeGraceDays: 7, lateFeeMaxCents: 5000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      lateFeeType: 'flat',
      lateFeeValueCents: 2500,
      lateFeeGraceDays: 7,
      lateFeeMaxCents: 5000,
    });

    const stored = await built.repo.findByTenant(TENANT);
    expect(stored).toMatchObject({
      tenantId: TENANT,
      enabled: true,
      lateFeeType: 'flat',
      lateFeeValueCents: 2500,
      lateFeeGraceDays: 7,
      lateFeeMaxCents: 5000,
      reminderSteps: defaultDunningConfig(TENANT).reminderSteps,
    });

    const got = await request(built.app).get('/api/settings/dunning');
    expect(got.body).toMatchObject({ configured: true, lateFeeType: 'flat', lateFeeMaxCents: 5000 });
  });

  it('owner sets an uncapped percent fee in basis points', async () => {
    const res = await request(built.app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'percent', lateFeeValueCents: 150, lateFeeGraceDays: 0, lateFeeMaxCents: null });
    expect(res.status).toBe(200);
    const stored = await built.repo.findByTenant(TENANT);
    expect(stored?.lateFeeType).toBe('percent');
    expect(stored?.lateFeeValueCents).toBe(150);
    expect(stored?.lateFeeMaxCents).toBeUndefined();
    expect(res.body.lateFeeMaxCents).toBeNull();
  });

  it('keeps a stored reminder cadence and the stored config id when only the late fee changes', async () => {
    const existing = {
      ...defaultDunningConfig(TENANT),
      enabled: true,
      reminderSteps: [{ offsetDays: 5, channel: 'email' as const }],
    };
    await built.repo.upsert(existing);
    await request(built.app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'flat', lateFeeValueCents: 1000 })
      .expect(200);
    const stored = await built.repo.findByTenant(TENANT);
    expect(stored?.id).toBe(existing.id);
    expect(stored?.reminderSteps).toEqual([{ offsetDays: 5, channel: 'email' }]);
    expect(stored?.lateFeeGraceDays).toBe(0);
  });

  it('turning the fee off clears the amount, grace and cap', async () => {
    await request(built.app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'flat', lateFeeValueCents: 2500, lateFeeGraceDays: 7, lateFeeMaxCents: 5000 })
      .expect(200);
    const res = await request(built.app).put('/api/settings/dunning').send({ lateFeeType: 'none' });
    expect(res.status).toBe(200);
    expect(await built.repo.findByTenant(TENANT)).toMatchObject({
      lateFeeType: 'none',
      lateFeeValueCents: 0,
      lateFeeGraceDays: 0,
      lateFeeMaxCents: undefined,
    });
  });

  it('audits the change with the previous and next policy', async () => {
    await request(built.app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'flat', lateFeeValueCents: 2500, lateFeeGraceDays: 7, lateFeeMaxCents: 5000 })
      .expect(200);
    expect(built.events).toHaveLength(1);
    expect(built.events[0]).toMatchObject({
      eventType: 'settings.dunning.updated',
      entityType: 'invoice_dunning_config',
      metadata: {
        previous: { lateFeeType: 'none', lateFeeValueCents: 0, lateFeeGraceDays: 0, lateFeeMaxCents: null },
        next: { lateFeeType: 'flat', lateFeeValueCents: 2500, lateFeeGraceDays: 7, lateFeeMaxCents: 5000 },
      },
    });
  });

  it.each([
    ['a percent fee above 100% (10000 bps)', { lateFeeType: 'percent', lateFeeValueCents: 10001 }],
    ['a flat fee with no amount', { lateFeeType: 'flat' }],
    ['a flat fee of zero', { lateFeeType: 'flat', lateFeeValueCents: 0 }],
    ['fractional cents', { lateFeeType: 'flat', lateFeeValueCents: 12.5 }],
    ['a negative grace period', { lateFeeType: 'flat', lateFeeValueCents: 100, lateFeeGraceDays: -1 }],
    ['a negative cap', { lateFeeType: 'flat', lateFeeValueCents: 100, lateFeeMaxCents: -1 }],
    ['an unknown fee type', { lateFeeType: 'compound', lateFeeValueCents: 100 }],
    ['a field outside the late-fee policy (enabled)', { lateFeeType: 'none', enabled: false }],
    ['a field outside the late-fee policy (reminderSteps)', { lateFeeType: 'none', reminderSteps: [] }],
    ['a caller-supplied tenantId', { lateFeeType: 'flat', lateFeeValueCents: 100, tenantId: OTHER_TENANT }],
  ])('400s %s and writes nothing', async (_label, body) => {
    const res = await request(built.app).put('/api/settings/dunning').send(body);
    expect(res.status).toBe(400);
    expect(await built.repo.findByTenant(TENANT)).toBeNull();
    expect(await built.repo.findByTenant(OTHER_TENANT)).toBeNull();
    expect(built.events).toHaveLength(0);
  });

  it.each([['technician'], ['dispatcher']] as const)('refuses a %s (403) and writes nothing', async (role) => {
    const { app, repo, events } = await buildApp({ role });
    const res = await request(app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'flat', lateFeeValueCents: 2500 });
    expect(res.status).toBe(403);
    expect(await repo.findByTenant(TENANT)).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('503s when no dunning repository is wired', async () => {
    const res = await request((await buildApp({ wired: false })).app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'flat', lateFeeValueCents: 2500 });
    expect(res.status).toBe(503);
  });
});
