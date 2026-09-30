/**
 * #1489 — createApp() wires Idempotency-Key handling onto every create route
 * (customers, jobs, appointments, estimates, invoices, record payment).
 *
 * Hermetic boot (DEV_AUTH_BYPASS, no DATABASE_URL → in-memory store). A
 * malformed key is rejected 400 INVALID_IDEMPOTENCY_KEY only by the
 * idempotency middleware, so seeing it on a path proves the path is wired; a
 * full replay through the real customers router proves it runs end to end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

describe('createApp — Idempotency-Key wiring on create routes (#1489)', () => {
  let app: AppWithLifecycle;
  let prev: Record<string, string | undefined>;
  const auth = `Bearer ${unsignedJwt({
    sub: 'idem_dev_owner',
    sid: 'idem-session',
    role: 'owner',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;

  beforeAll(async () => {
    prev = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      DATABASE_URL: process.env.DATABASE_URL,
      AI_PROVIDER_API_KEY: process.env.AI_PROVIDER_API_KEY,
      CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    delete process.env.DATABASE_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
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

  it.each([
    '/api/customers',
    '/api/jobs',
    '/api/appointments',
    '/api/estimates',
    '/api/invoices',
    '/api/payments',
  ])('POST %s honours Idempotency-Key (a malformed key is rejected 400)', async (path) => {
    const res = await request(app)
      .post(path)
      .set('Authorization', auth)
      .set('Idempotency-Key', 'k'.repeat(256))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('a retried customer create replays the first response', async () => {
    const body = { firstName: 'Wired', lastName: 'Idem1489' };
    const first = await request(app)
      .post('/api/customers')
      .set('Authorization', auth)
      .set('Idempotency-Key', 'wiring-replay-1')
      .send(body);
    expect(first.status).toBe(201);
    const second = await request(app)
      .post('/api/customers')
      .set('Authorization', auth)
      .set('Idempotency-Key', 'wiring-replay-1')
      .send(body);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
  });
});
