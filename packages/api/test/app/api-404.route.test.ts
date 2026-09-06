/**
 * RIVET C-1 — JSON 404 for unmatched API-shaped routes.
 *
 * Before this fix, an unmatched `/api/*`, `/public/*`, or `/webhooks/*`
 * path fell through to the SPA catch-all at the bottom of createApp():
 * 200 text/html (SPA shell) when packages/web/dist is built, or the
 * "Frontend assets unavailable" 500 when it isn't. Mobile hooks do
 * `if (!res.ok) throw` then `res.json()`, so the unexpected HTML body
 * surfaced as an opaque SyntaxError ("Unknown error").
 *
 * Boots the REAL createApp() (pattern: test/app/http-wiring.route.test.ts,
 * test/app/create-app-overrides.test.ts) — NODE_ENV=dev + DEV_AUTH_BYPASS
 * so `/api` routes can be exercised authenticated without real Clerk
 * tokens, and no DATABASE_URL so every repository falls back to its
 * InMemory variant (hermetic, no Postgres).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

describe('API-shaped 404 (RIVET C-1)', () => {
  let app: AppWithLifecycle;
  let prev: Record<string, string | undefined>;
  const auth = `Bearer ${unsignedJwt({
    sub: 'hermetic_dev_owner',
    sid: 'hermetic-session',
    role: 'owner',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;

  beforeAll(() => {
    prev = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      DATABASE_URL: process.env.DATABASE_URL,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    delete process.env.DATABASE_URL;
    resetConfig();
    app = createApp();
  });

  afterAll(async () => {
    await app.gracefulDrain('test-cleanup');
    resetConfig();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('authenticated GET /api/does-not-exist returns 404 JSON, not the SPA shell', async () => {
    const res = await request(app)
      .get('/api/does-not-exist')
      .set('Authorization', auth);

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/json');
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Route not found' });
  });

  it('authenticated POST /api/does-not-exist also returns 404 JSON (every method, not just GET)', async () => {
    const res = await request(app)
      .post('/api/does-not-exist')
      .set('Authorization', auth)
      .send({ anything: true });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Route not found' });
  });

  it('unauthenticated GET /public/does-not-exist returns 404 JSON (public surface needs no auth to hit the 404)', async () => {
    const res = await request(app).get('/public/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Route not found' });
  });

  it('GET /webhooks/does-not-exist returns 404 JSON', async () => {
    const res = await request(app).get('/webhooks/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Route not found' });
  });

  it('a non-API path (e.g. /customers/123) still reaches the SPA catch-all, not the new JSON 404', async () => {
    // The SPA catch-all sits AFTER our new middleware and is mounted on '*',
    // so it only ever sees paths that aren't /api, /public, or /webhooks.
    // packages/web/dist is not built in this test environment, so the real,
    // unmodified catch-all behavior here is its documented failure path:
    // a 500 with the "Frontend assets unavailable" envelope (see app.ts's
    // `app.get('*', ...)`). That 500 body is what's asserted below — it is
    // deterministic in CI/this sandbox (no build step ran) and, crucially,
    // is NOT the `{ error: 'NOT_FOUND', ... }` shape our new middleware
    // produces, which is the thing this test needs to prove: non-API paths
    // are untouched by the C-1 fix.
    const res = await request(app).get('/customers/123');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: 'Frontend assets unavailable' });
  });
});
