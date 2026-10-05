/**
 * #1205 item 3 — a 5xx that a route handler writes ITSELF (the ~107
 * `catch { res.status(500).json(...) }` sites) and an error that surfaces
 * after the response is committed must still reach Sentry. Neither passes
 * through captureServerError on its own: the handler never calls next(err),
 * and the global handler's headers-sent branch only ends the response.
 *
 * Same hermetic real-createApp() boot as global-error-handler-sentry.test.ts;
 * the /api/customers and /webhooks routers are swapped for stand-ins that
 * reproduce each shape, with every real middleware still in front of them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Router, type NextFunction, type Request, type Response } from 'express';

vi.mock('../../src/routes/customers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/routes/customers')>();
  return {
    ...actual,
    createCustomerRouter: () => {
      const router = Router();
      // The pattern at invoices.ts / appointments.ts: catch, answer 500, never next(err).
      router.get('/self-500', (_req: Request, res: Response) => {
        res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load customers' });
      });
      router.get('/self-503', (_req: Request, res: Response) => {
        res.status(503).json({ error: 'UNAVAILABLE', message: 'try later' });
      });
      router.get('/self-404', (_req: Request, res: Response) => {
        res.status(404).json({ error: 'NOT_FOUND', message: 'nope' });
      });
      // Thrown error: the global handler already captures it — must stay ONE event.
      router.get('/boom', () => {
        throw new Error('customer boom');
      });
      // Response committed, THEN the failure surfaces (streaming / asyncRoute headersSent path).
      router.get('/late', (_req: Request, res: Response, next: NextFunction) => {
        res.status(200).json({ ok: true });
        next(new Error('late boom'));
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
      router.post('/self-500', (_req: Request, res: Response) => {
        res.status(500).send('error');
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
  sub: 'handler_5xx_dev_owner',
  sid: 'handler-5xx-session',
  role: 'owner',
  exp: Math.floor(Date.now() / 1000) + 3600,
})}`;

const tagsOf = (client: ReturnType<typeof makeFakeClient>) =>
  Object.fromEntries(client.calls.tags) as Record<string, string>;

describe('handler-written 5xx and post-headers-sent errors → Sentry (#1205 item 3)', () => {
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
  });

  afterEach(() => {
    resetSentryClient();
  });

  it('reports a 500 the handler wrote itself, tagged like any other server error', async () => {
    const res = await request(app)
      .get('/api/customers/self-500')
      .set('Authorization', AUTH)
      .set('x-correlation-id', 'corr-self-500');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL_ERROR', message: 'Failed to load customers' });

    await vi.waitFor(() => expect(client.calls.captured).toHaveLength(1));
    const tags = tagsOf(client);
    expect(tags.request_id).toBe('corr-self-500');
    expect(tags.route).toContain('/api/customers/self-500');
    expect(tags.tenant_id).toEqual(expect.any(String));
  });

  it('still reports a thrown 500 exactly once, as the real error', async () => {
    const res = await request(app).get('/api/customers/boom').set('Authorization', AUTH);

    expect(res.status).toBe(500);
    await settle();
    expect(client.calls.captured).toHaveLength(1);
    expect((client.calls.captured[0] as Error).message).toBe('customer boom');
  });

  it('reports an error that surfaces after the response was already sent', async () => {
    const res = await request(app)
      .get('/api/customers/late')
      .set('Authorization', AUTH)
      .set('x-correlation-id', 'corr-late');

    // The committed response is untouched (#1090).
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    await vi.waitFor(() => expect(client.calls.captured).toHaveLength(1));
    expect((client.calls.captured[0] as Error).message).toBe('late boom');
    expect(tagsOf(client).request_id).toBe('corr-late');
  });

  it('reports a handler-written 503 and a non-/api (webhook) 500 without a tenant tag', async () => {
    await request(app).get('/api/customers/self-503').set('Authorization', AUTH).expect(503);
    await vi.waitFor(() => expect(client.calls.captured).toHaveLength(1));

    client = makeFakeClient();
    setSentryClient(client);
    await request(app).post('/webhooks/self-500').send({}).expect(500);
    await vi.waitFor(() => expect(client.calls.captured).toHaveLength(1));
    const tags = tagsOf(client);
    expect(tags.route).toBe('/webhooks/self-500');
    expect(tags).not.toHaveProperty('tenant_id');
  });

  it('structural: the report hook sits in front of EVERY router createApp mounts', () => {
    // Behavioural tests above cover two routers; this guards the rest. Any
    // router (or future router) mounted ahead of the hook would let its
    // handler-written 500s escape Sentry again.
    type Layer = { name: string; handle: { name?: string } };
    // Express 5 exposes the app's router as `app.router` (Express 4: `_router`).
    const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
    const hookAt = stack.findIndex((l) => l.handle.name === 'reportHandlerWrittenServerErrorsHook');
    expect(hookAt).toBeGreaterThanOrEqual(0);
    const routersBefore = stack.slice(0, hookAt).filter((l) => l.name === 'router');
    expect(routersBefore).toEqual([]);
    expect(stack.slice(hookAt).filter((l) => l.name === 'router').length).toBeGreaterThan(50);
  });

  it('never reports a handler-written 4xx', async () => {
    await request(app).get('/api/customers/self-404').set('Authorization', AUTH).expect(404);
    await settle();
    expect(client.calls.captured).toHaveLength(0);
  });
});

/** Let the post-`finish` tick run so a late (duplicate) report would land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
