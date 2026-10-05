/**
 * #1555 — Express 5 ships body-parser 2, which leaves `req.body` UNDEFINED
 * when no parser populated it (no body, or a content-type the parser does
 * not handle). Express 4's body-parser always initialised it to `{}`, and
 * route handlers across the API rely on that (`const { content } =
 * req.body;` then a 400 for the missing field). Without the fix, a bodiless
 * request turns a documented 400 into a TypeError → 500.
 *
 * Boots the REAL createApp() hermetically (pattern: api-404.route.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

describe('bodiless requests keep the Express 4 req.body contract (#1555)', () => {
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

  it('PUT /api/notes/:id with no body is a 400 VALIDATION_ERROR, not a 500', async () => {
    const res = await request(app)
      .put('/api/notes/00000000-0000-4000-8000-000000000001')
      .set('Authorization', auth);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'VALIDATION_ERROR', message: 'content is required' });
  });
});
