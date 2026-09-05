/**
 * R1 follow-up — asyncRoute maps handler rejections to a response inline
 * (it never reaches the global error handler), so it must capture its own
 * 5xx to Sentry through the shared helper the global handler uses. Response
 * behaviour is unchanged; 4xx-mapped errors are never captured.
 *
 * Fake SentryClient mirrors test/monitoring/instrumentation.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

import { asyncRoute } from '../../src/middleware/async-route';
import { NotFoundError } from '../../src/shared/errors';
import {
  setSentryClient,
  resetSentryClient,
  type SentryClient,
  type SentryScope,
  type SentryTransaction,
} from '../../src/monitoring/sentry';

function makeFakeClient(): SentryClient & {
  calls: { tags: Array<[string, string]>; captured: unknown[] };
} {
  const calls = { tags: [] as Array<[string, string]>, captured: [] as unknown[] };
  return {
    calls,
    captureException(err: Error): string {
      calls.captured.push(err);
      return 'fake-event-id';
    },
    captureMessage(): string {
      return 'fake-event-id';
    },
    setTag(): void {},
    setUser(): void {},
    startTransaction(): SentryTransaction {
      return { finish() {}, setStatus() {} };
    },
    withScope<T>(cb: (scope: SentryScope) => T): T {
      return cb({
        setTag(key: string, value: string): void {
          calls.tags.push([key, value]);
        },
        captureException(err: Error): string {
          calls.captured.push(err);
          return 'fake-event-id';
        },
      });
    },
  };
}

const tagsOf = (client: ReturnType<typeof makeFakeClient>) =>
  Object.fromEntries(client.calls.tags) as Record<string, string>;

function buildApp(): Express {
  const app = express();
  // Stand-in for request logging + auth: the same pre-redacted fields the
  // real middleware attaches (request-logging.ts, dev-auth-bypass/clerk).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, {
      safeRequestLog: { route: '/api/things/redacted', correlation_id: 'corr-async-route' },
      auth: { userId: 'user_1', tenantId: 'tenant_async_route' },
    });
    next();
  });
  app.get(
    '/api/things/boom',
    asyncRoute(async () => {
      throw new Error('async boom');
    }),
  );
  app.get(
    '/api/things/missing',
    asyncRoute(async () => {
      throw new NotFoundError('thing', 'nope');
    }),
  );
  app.get(
    '/api/things/ok',
    asyncRoute(async (_req, res) => {
      res.json({ ok: true });
    }),
  );
  return app;
}

describe('asyncRoute → Sentry capture (R1)', () => {
  let client: ReturnType<typeof makeFakeClient>;
  const app = buildApp();

  beforeEach(() => {
    client = makeFakeClient();
    setSentryClient(client);
  });

  afterEach(() => {
    resetSentryClient();
  });

  it('captures a rejected handler once as 500 with route, request_id and tenant_id tags', async () => {
    const res = await request(app).get('/api/things/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });

    expect(client.calls.captured).toHaveLength(1);
    expect((client.calls.captured[0] as Error).message).toBe('async boom');
    expect(tagsOf(client)).toEqual({
      route: '/api/things/redacted',
      request_id: 'corr-async-route',
      tenant_id: 'tenant_async_route',
    });
  });

  it('does not capture a 404-mapped error', async () => {
    const res = await request(app).get('/api/things/missing');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(client.calls.captured).toHaveLength(0);
    expect(client.calls.tags).toHaveLength(0);
  });

  it('does not touch Sentry on success', async () => {
    const res = await request(app).get('/api/things/ok');

    expect(res.status).toBe(200);
    expect(client.calls.captured).toHaveLength(0);
  });

  it('still returns the JSON envelope with no client registered (no DSN)', async () => {
    resetSentryClient();

    const res = await request(app).get('/api/things/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(client.calls.captured).toHaveLength(0);
  });
});
