/**
 * SEC-20 / SEC-26 — request logging must never leak a live bearer token,
 * and must attribute logs to the VERIFIED tenant, not a forgeable header.
 *
 * SEC-20: bearer tokens travel in the URL on public, token-gated routes
 * (`/public/estimates/:token/approve`, `?token=...` query params). The
 * `route` field on every log line used to be `req.originalUrl` logged
 * verbatim — these tests prove the raw token never reaches the emitted
 * log object, on both a path-segment token route and a query-param token
 * route, while an ordinary authenticated route logs unchanged.
 *
 * SEC-26: `tenant_id` on the log line must come from `req.auth.tenantId`
 * (set by verified Clerk middleware) rather than the client-forgeable
 * `x-tenant-id` header, whenever `req.auth` is present.
 *
 * We mount the middleware directly on a stand-alone express app (like
 * middleware/helmet.test.ts) with a mock Logger, rather than booting the
 * full app (which needs a live Pg pool + production secrets).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequestLoggingMiddleware } from '../../src/middleware/request-logging';
import type { Logger } from '../../src/logging/logger';

const TOKEN = 'abc123.def456-ghiJKL_verylongtoken789';

function createMockLogger(): { logger: Logger; calls: Array<{ message: string; meta?: Record<string, unknown> }> } {
  const calls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: () => {},
    info: (message, meta) => {
      calls.push({ message, meta });
    },
    warn: () => {},
    error: () => {},
    child() {
      return logger;
    },
  };
  return { logger, calls };
}

function makeApp(logger: Logger, opts?: { withAuth?: boolean }): express.Express {
  const app = express();
  if (opts?.withAuth) {
    // Simulate verified Clerk auth having already run and populated
    // req.auth before request-logging observes the request.
    app.use((req: any, _res, next) => {
      req.auth = { userId: 'u1', tenantId: 'verified-tenant', role: 'owner' };
      next();
    });
  }
  app.use(createRequestLoggingMiddleware(logger));
  app.get('/api/jobs', (_req, res) => res.json({ ok: true }));
  app.get('/public/estimates/:token/approve', (_req, res) => res.json({ ok: true }));
  app.post('/public/estimates/:token/approve', (_req, res) => res.json({ ok: true }));
  app.get('/public/proposals/one-tap-approve', (_req, res) => res.status(200).send('ok'));
  return app;
}

describe('SEC-20 — request logging scrubs bearer tokens out of the route field', () => {
  let logger: Logger;
  let calls: Array<{ message: string; meta?: Record<string, unknown> }>;

  beforeEach(() => {
    ({ logger, calls } = createMockLogger());
  });

  it('masks the token path segment for /public/estimates/:token/approve and never emits the raw token', async () => {
    const app = makeApp(logger);
    await request(app).get(`/public/estimates/${TOKEN}/approve`);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const serialized = JSON.stringify(call.meta);
      expect(serialized).not.toContain(TOKEN);
    }

    const incoming = calls.find((c) => c.message === 'incoming request');
    const route = (incoming?.meta?.safeRequestLog as any)?.route;
    expect(route).toBe('/public/estimates/[REDACTED]/approve');
  });

  it('masks a ?token= query param and never emits the raw token', async () => {
    const app = makeApp(logger);
    await request(app).get('/public/proposals/one-tap-approve').query({ token: TOKEN });

    for (const call of calls) {
      const serialized = JSON.stringify(call.meta);
      expect(serialized).not.toContain(TOKEN);
    }

    const incoming = calls.find((c) => c.message === 'incoming request');
    const route = (incoming?.meta?.safeRequestLog as any)?.route;
    expect(route).toBe('/public/proposals/one-tap-approve?token=[REDACTED]');
  });

  it('leaves a normal authenticated route (/api/jobs) unchanged', async () => {
    const app = makeApp(logger);
    await request(app).get('/api/jobs');

    const incoming = calls.find((c) => c.message === 'incoming request');
    const route = (incoming?.meta?.safeRequestLog as any)?.route;
    expect(route).toBe('/api/jobs');
  });
});

describe('SEC-26 — tenant attribution prefers verified req.auth.tenantId over the forgeable header', () => {
  let logger: Logger;
  let calls: Array<{ message: string; meta?: Record<string, unknown> }>;

  beforeEach(() => {
    ({ logger, calls } = createMockLogger());
  });

  it('uses req.auth.tenantId even when a conflicting x-tenant-id header is present', async () => {
    const app = makeApp(logger, { withAuth: true });
    await request(app).get('/api/jobs').set('x-tenant-id', 'forged-tenant');

    const incoming = calls.find((c) => c.message === 'incoming request');
    const tenantId = (incoming?.meta?.safeRequestLog as any)?.tenant_id;
    expect(tenantId).toBe('verified-tenant');
    expect(tenantId).not.toBe('forged-tenant');
  });

  it('falls back to the x-tenant-id header only when there is no verified req.auth (e.g. public routes)', async () => {
    const app = makeApp(logger); // no auth middleware mounted
    await request(app).get('/api/jobs').set('x-tenant-id', 'header-tenant');

    const incoming = calls.find((c) => c.message === 'incoming request');
    const tenantId = (incoming?.meta?.safeRequestLog as any)?.tenant_id;
    expect(tenantId).toBe('header-tenant');
  });
});
