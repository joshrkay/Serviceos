import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import type { Express } from 'express';
import { createAdminTenantsRouter } from '../../src/routes/admin-tenants';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemoryPlatformAdminChecker,
  requirePlatformAdmin,
} from '../../src/auth/platform-admin';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type {
  TenantUsageReport,
  UsageWindow,
} from '../../src/admin/tenant-usage';

const ADMIN_HOME_TENANT = '00000000-0000-0000-0000-000000000001';
const TARGET = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-12T12:00:00.000Z');

function report(window: UsageWindow): TenantUsageReport {
  const zero = {
    runs: 0,
    failedRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicroCents: 0,
    unpricedRuns: 0,
  };
  return {
    tenant: {
      id: TARGET,
      name: 'Acme HVAC',
      planId: 'growth',
      subscriptionStatus: 'active',
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    ai: {
      totals: { ...zero, runs: 3, failedRuns: 1, inputTokens: 300, outputTokens: 60, costMicroCents: 1_500_000 },
      byTaskType: [{ taskType: 'draft_estimate', ...zero, runs: 3, failedRuns: 1, inputTokens: 300, outputTokens: 60, costMicroCents: 1_500_000 }],
    },
    voice: {
      calls: 2,
      billableCalls: 1,
      billableSeconds: 61,
      billableMinutes: 2,
      providerCostMicroCents: { total: 900, byProvider: [{ provider: 'twilio', costMicroCents: 900 }] },
    },
    activity: {
      auditEventCount: 4,
      lastActivityAt: '2026-10-11T00:00:00.000Z',
      topEventTypes: [{ eventType: 'job.created', count: 4 }],
    },
    users: { count: 2 },
  };
}

function buildApp(
  opts: {
    platformAdmins?: string[];
    tenantExists?: boolean;
    authenticated?: boolean;
    auditFails?: boolean;
  } = {},
): {
  app: Express;
  getUsage: ReturnType<typeof vi.fn>;
  auditRepo: InMemoryAuditRepository;
} {
  const app = express();
  app.use(express.json());
  if (opts.authenticated !== false) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'user-1',
        sessionId: 's',
        tenantId: ADMIN_HOME_TENANT,
        role: 'owner',
      };
      next();
    });
  }

  const getUsage = vi.fn(async (_tenantId: string, window: UsageWindow) =>
    opts.tenantExists === false ? null : report(window),
  );
  const auditRepo = new InMemoryAuditRepository();
  if (opts.auditFails) {
    vi.spyOn(auditRepo, 'create').mockRejectedValue(new Error('audit store down'));
  }
  const checker = new InMemoryPlatformAdminChecker(opts.platformAdmins ?? []);

  app.use(
    '/api/admin/tenants',
    createAdminTenantsRouter({
      pool: { query: vi.fn() } as never,
      queue: { send: vi.fn() } as never,
      usageRepo: { getUsage },
      auditRepo,
      requirePlatformAdmin: requirePlatformAdmin(checker),
      now: () => NOW,
    }),
  );
  return { app, getUsage, auditRepo };
}

const url = (tenantId = TARGET) => `/api/admin/tenants/${tenantId}/usage`;

describe('GET /api/admin/tenants/:tenantId/usage — auth', () => {
  it('401 when unauthenticated', async () => {
    const { app, getUsage } = buildApp({ authenticated: false, platformAdmins: ['user-1'] });
    const res = await request(app).get(url());
    expect(res.status).toBe(401);
    expect(getUsage).not.toHaveBeenCalled();
  });

  it('403 for a non-platform-admin (tenant owner)', async () => {
    const { app, getUsage } = buildApp({ platformAdmins: [] });
    const res = await request(app).get(url());
    expect(res.status).toBe(403);
    expect(getUsage).not.toHaveBeenCalled();
  });

  it('403 for a tenant owner reading their OWN tenant', async () => {
    const { app, getUsage } = buildApp({ platformAdmins: [] });
    const res = await request(app).get(url(ADMIN_HOME_TENANT));
    expect(res.status).toBe(403);
    expect(getUsage).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/tenants/:tenantId/usage — validation', () => {
  it.each([
    ['non-UUID tenant id', '/api/admin/tenants/not-a-uuid/usage'],
    ['malformed from', `${url()}?from=yesterday`],
    ['from == to', `${url()}?from=2026-10-01T00:00:00Z&to=2026-10-01T00:00:00Z`],
    ['from after to', `${url()}?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z`],
    ['window > 366 days', `${url()}?from=2025-01-01T00:00:00Z&to=2026-01-03T00:00:00Z`],
    ['from after the default to (now)', `${url()}?from=2026-10-20T00:00:00Z`],
  ])('400 for %s', async (_label, path) => {
    const { app, getUsage, auditRepo } = buildApp({ platformAdmins: ['user-1'] });
    const res = await request(app).get(path);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(getUsage).not.toHaveBeenCalled();
    expect(await auditRepo.findByEntity(ADMIN_HOME_TENANT, 'tenant', TARGET)).toHaveLength(0);
  });

  it('404 for an unknown tenant, and no access audit row', async () => {
    const { app, auditRepo } = buildApp({ platformAdmins: ['user-1'], tenantExists: false });
    const res = await request(app).get(url());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(await auditRepo.findByEntity(ADMIN_HOME_TENANT, 'tenant', TARGET)).toHaveLength(0);
  });
});

describe('GET /api/admin/tenants/:tenantId/usage — report', () => {
  it('defaults to the trailing 30 days ending now', async () => {
    const { app, getUsage } = buildApp({ platformAdmins: ['user-1'] });
    const res = await request(app).get(url());
    expect(res.status).toBe(200);
    expect(getUsage).toHaveBeenCalledWith(TARGET, {
      from: new Date('2026-09-12T12:00:00.000Z'),
      to: NOW,
    });
    expect(res.body.window).toEqual({
      from: '2026-09-12T12:00:00.000Z',
      to: '2026-10-12T12:00:00.000Z',
    });
  });

  it('passes an explicit window through (accepts offsets and date-only)', async () => {
    const { app, getUsage } = buildApp({ platformAdmins: ['user-1'] });
    const res = await request(app).get(`${url()}?from=2026-09-01&to=2026-09-30T20:00:00-04:00`);
    expect(res.status).toBe(200);
    expect(getUsage).toHaveBeenCalledWith(TARGET, {
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-10-01T00:00:00.000Z'),
    });
  });

  it('returns the report shape with integer money', async () => {
    const { app } = buildApp({ platformAdmins: ['user-1'] });
    const res = await request(app).get(url());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['activity', 'ai', 'tenant', 'users', 'voice', 'window'].sort(),
    );
    expect(res.body.tenant).toMatchObject({ id: TARGET, planId: 'growth', subscriptionStatus: 'active' });
    expect(res.body.ai.totals.costMicroCents).toBe(1_500_000);
    expect(Number.isInteger(res.body.voice.providerCostMicroCents.total)).toBe(true);
    expect(res.body.voice.billableMinutes).toBe(2);
    expect(res.body.activity.topEventTypes).toEqual([{ eventType: 'job.created', count: 4 }]);
    expect(res.body.users).toEqual({ count: 2 });
  });

  it('audits the cross-tenant read under the admin home tenant with scope platform', async () => {
    const { app, auditRepo } = buildApp({ platformAdmins: ['user-1'] });
    await request(app).get(url()).expect(200);
    const events = await auditRepo.findByEntity(ADMIN_HOME_TENANT, 'tenant', TARGET);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: ADMIN_HOME_TENANT,
      actorId: 'user-1',
      eventType: 'admin.tenant_usage_viewed',
      metadata: {
        scope: 'platform',
        targetTenantId: TARGET,
        from: '2026-09-12T12:00:00.000Z',
        to: '2026-10-12T12:00:00.000Z',
      },
    });
  });

  it('does not return the report when the access audit cannot be written', async () => {
    const { app } = buildApp({ platformAdmins: ['user-1'], auditFails: true });
    const res = await request(app).get(url());
    expect(res.status).toBe(500);
    expect(res.body.tenant).toBeUndefined();
  });
});
