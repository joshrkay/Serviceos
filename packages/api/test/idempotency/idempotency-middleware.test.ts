/**
 * #1489 — `createIdempotencyMiddleware` over the in-memory store (the store
 * the API uses when no DATABASE_URL is wired). The Postgres store, the
 * request transaction and the real routers are covered in
 * test/integration/idempotency-keys-1489.test.ts.
 */
import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { createIdempotencyMiddleware } from '../../src/idempotency/idempotency-middleware';
import { InMemoryIdempotencyStore } from '../../src/idempotency/idempotency-store';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

function buildApp(handler: (req: Request, res: Response) => void) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: '00000000-0000-4000-8000-000000000001',
      role: 'owner',
    };
    next();
  });
  app.post('/api/widgets', createIdempotencyMiddleware(new InMemoryIdempotencyStore()), handler);
  return app;
}

describe('createIdempotencyMiddleware (#1489)', () => {
  it('rejects a malformed key with 400 INVALID_IDEMPOTENCY_KEY before running the handler', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => {
      calls += 1;
      res.status(201).json({ n: calls });
    });
    const tooLong = await request(app).post('/api/widgets').set('Idempotency-Key', 'x'.repeat(256)).send({});
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
    const empty = await request(app).post('/api/widgets').set('Idempotency-Key', '').send({});
    expect(empty.status).toBe(400);
    expect(calls).toBe(0);
  });

  it('a failed attempt is not stored: retrying the same key and body runs the handler again', async () => {
    let calls = 0;
    const app = buildApp((_req, res) => {
      calls += 1;
      if (calls === 1) res.status(503).json({ error: 'UPSTREAM_DOWN' });
      else res.status(201).json({ id: 'w-1' });
    });
    const first = await request(app).post('/api/widgets').set('Idempotency-Key', 'k-fail').send({ a: 1 });
    expect(first.status).toBe(503);
    const retry = await request(app).post('/api/widgets').set('Idempotency-Key', 'k-fail').send({ a: 1 });
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual({ id: 'w-1' });
    expect(calls).toBe(2);
  });

  it('a duplicate that arrives while the first is in flight gets 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    let calls = 0;
    let finishFirst: () => void = () => {};
    const firstMayFinish = new Promise<void>((resolve) => { finishFirst = resolve; });
    const app = buildApp((_req, res) => {
      calls += 1;
      void firstMayFinish.then(() => res.status(201).json({ id: 'w-slow' }));
    });
    const first = request(app).post('/api/widgets').set('Idempotency-Key', 'k-slow').send({ a: 1 }).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const dup = await request(app).post('/api/widgets').set('Idempotency-Key', 'k-slow').send({ a: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('IDEMPOTENCY_IN_PROGRESS');
    finishFirst();
    expect((await first).status).toBe(201);
    expect(calls).toBe(1);
  });
});
