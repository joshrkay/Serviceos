/**
 * U1 (R1) — the global error handler in app.ts captures every unhandled 5xx
 * to Sentry with per-event scope tags (route, request_id, tenant_id).
 *
 * Driven against the REAL createApp() with supertest (same hermetic boot as
 * test/app/http-wiring.route.test.ts and test/app/create-app-overrides.test.ts:
 * NODE_ENV=dev + DEV_AUTH_BYPASS so /api routes authenticate without Clerk,
 * no DATABASE_URL so every repo is in-memory). No production route reaches
 * the global handler on its own in this boot (asyncRoute maps errors inline;
 * withTenantTransaction is pool-gated), so the two routers mounted at
 * /api/customers and /webhooks are swapped for throwing stand-ins via
 * vi.mock — every real middleware in front of them (request logging, which
 * mints correlation_id + the redacted route; auth, which sets req.auth) and
 * the real global handler behind them still run.
 *
 * The fake SentryClient mirrors test/monitoring/instrumentation.test.ts and is
 * installed AFTER createApp() because createApp() itself calls setSentryClient.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Router, type NextFunction, type Request, type Response } from 'express';

import { NotFoundError } from '../../src/shared/errors';

const recorded: { apiTenantId: string | undefined } = { apiTenantId: undefined };

vi.mock('../../src/routes/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/routes/customers')>();
  return {
    ...actual,
    createCustomerRouter: () => {
      const router = Router();
      // Sync throw — Express 4 forwards it to the next error middleware,
      // i.e. captureRequestError → the global handler.
      router.get('/boom', (req: Request) => {
        recorded.apiTenantId = (req as { auth?: { tenantId?: string } }).auth?.tenantId;
        throw new Error('customer boom');
      });
      router.get('/missing', () => {
        throw new NotFoundError('customer', 'nope');
      });
      return router;
    },
  };
});

vi.mock('../../src/webhooks/routes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/webhooks/routes')>();
  return {
    ...actual,
    createWebhookRouter: () => {
      const router = Router();
      // next(err) — the delivery path withTenantTransaction / body-parser use.
      router.post('/boom', (_req: Request, _res: Response, next: NextFunction) => {
        next(new Error('webhook boom'));
      });
      return router;
    },
  };
});

import { createApp, type AppWithLifecycle } from '../../src/app';
import { resetConfig } from '../../src/shared/config';
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

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

const AUTH = `Bearer ${unsignedJwt({
  sub: 'sentry_handler_dev_owner',
  sid: 'sentry-handler-session',
  role: 'owner',
  exp: Math.floor(Date.now() / 1000) + 3600,
})}`;

const tagsOf = (client: ReturnType<typeof makeFakeClient>) =>
  Object.fromEntries(client.calls.tags) as Record<string, string>;

describe('global error handler → Sentry capture (U1 / R1)', () => {
  let app: AppWithLifecycle;
  let prev: Record<string, string | undefined>;
  let client: ReturnType<typeof makeFakeClient>;

  beforeAll(() => {
    prev = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      DATABASE_URL: process.env.DATABASE_URL,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
      SENTRY_DSN: process.env.SENTRY_DSN,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    delete process.env.DATABASE_URL;
    delete process.env.SENTRY_DSN;
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

  beforeEach(() => {
    client = makeFakeClient();
    setSentryClient(client);
    recorded.apiTenantId = undefined;
  });

  afterEach(() => {
    resetSentryClient();
  });

  it('captures an /api 500 once with route, request_id and tenant_id tags', async () => {
    const res = await request(app)
      .get('/api/customers/boom?token=secret-token-value')
      .set('Authorization', AUTH)
      .set('x-correlation-id', 'corr-api-500');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });

    expect(client.calls.captured).toHaveLength(1);
    expect((client.calls.captured[0] as Error).message).toBe('customer boom');

    const tags = tagsOf(client);
    expect(tags.request_id).toBe('corr-api-500');
    expect(recorded.apiTenantId).toEqual(expect.any(String));
    expect(tags.tenant_id).toBe(recorded.apiTenantId);
    // Route tag is the already-redacted safeRequestLog.route, never the raw URL.
    expect(tags.route).toContain('/api/customers/boom');
    expect(tags.route).not.toContain('secret-token-value');
  });

  it('captures a non-/api (webhook) 500 with route + request_id and no tenant_id tag', async () => {
    const res = await request(app)
      .post('/webhooks/boom')
      .set('x-correlation-id', 'corr-webhook-500')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });

    expect(client.calls.captured).toHaveLength(1);
    expect((client.calls.captured[0] as Error).message).toBe('webhook boom');

    const tags = tagsOf(client);
    expect(tags.request_id).toBe('corr-webhook-500');
    expect(tags.route).toBe('/webhooks/boom');
    expect(tags).not.toHaveProperty('tenant_id');
  });

  it('does not capture a mapped 4xx (thrown NotFoundError → 404)', async () => {
    const res = await request(app).get('/api/customers/missing').set('Authorization', AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
    expect(client.calls.captured).toHaveLength(0);
    expect(client.calls.tags).toHaveLength(0);
  });

  it('does not capture a body-parser 400 (malformed JSON)', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', AUTH)
      .set('content-type', 'application/json')
      .send('{"not": json');

    expect(res.status).toBe(400);
    expect(client.calls.captured).toHaveLength(0);
  });

  it('still returns the JSON error envelope when no Sentry client is registered (no DSN)', async () => {
    resetSentryClient();

    const res = await request(app).get('/api/customers/boom').set('Authorization', AUTH);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    expect(client.calls.captured).toHaveLength(0);
  });
});
