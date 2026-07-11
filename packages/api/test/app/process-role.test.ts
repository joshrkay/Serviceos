/**
 * WS2 — PROCESS_ROLE process split.
 *
 * A PROCESS_ROLE=web deploy serves the HTTP/voice/WS surface with ZERO
 * background worker loops, so it can never be coupled to (or blocked by) the
 * sweeps + queue-drain. 'worker' and 'all' run them; unset defaults to 'all'
 * (byte-for-byte back-compat with the single-service deploy).
 *
 * These assertions read `app.backgroundIntervalCount` — the count of gated
 * background WORKER intervals (cheap observability intervals that run in every
 * role are excluded from it). createApp() is booted in in-memory mode (no
 * DATABASE_URL) so the drain resolves instantly and no Pg/Redis is required;
 * each app is drained in afterEach to clear its intervals + signal handlers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

describe('WS2 — PROCESS_ROLE process split', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalProcessRole = process.env.PROCESS_ROLE;
  const created: AppWithLifecycle[] = [];

  const buildApp = (role: string | undefined): AppWithLifecycle => {
    if (role === undefined) {
      delete process.env.PROCESS_ROLE;
    } else {
      process.env.PROCESS_ROLE = role;
    }
    // Config is cached; reset so each build re-reads PROCESS_ROLE.
    resetConfig();
    const app = createApp();
    created.push(app);
    return app;
  };

  beforeEach(() => {
    // In-memory mode: no pool/Redis, so worker-object constructions take their
    // in-memory branches and the drain resolves without a real backend.
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    // Clear the intervals + SIGTERM/SIGINT handlers each createApp registered.
    for (const app of created.splice(0)) {
      await app.gracefulDrain('test-cleanup');
    }
    resetConfig();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalProcessRole === undefined) delete process.env.PROCESS_ROLE;
    else process.env.PROCESS_ROLE = originalProcessRole;
  });

  it('role "web" registers ZERO background worker intervals', () => {
    const app = buildApp('web');
    expect(app.backgroundIntervalCount).toBe(0);
  });

  it('roles "worker" and "all" register an identical, nonzero worker interval count', () => {
    const worker = buildApp('worker');
    const all = buildApp('all');
    expect(worker.backgroundIntervalCount).toBeGreaterThan(0);
    expect(all.backgroundIntervalCount).toBe(worker.backgroundIntervalCount);
  });

  it('default (PROCESS_ROLE unset) is identical to "all"', () => {
    const dflt = buildApp(undefined);
    const all = buildApp('all');
    expect(dflt.backgroundIntervalCount).toBeGreaterThan(0);
    expect(dflt.backgroundIntervalCount).toBe(all.backgroundIntervalCount);
  });

  it('role "web" still serves the HTTP surface (GET /health → 200)', async () => {
    const app = buildApp('web');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBeDefined();
  });
});
