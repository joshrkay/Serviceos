import { describe, it, expect, afterEach } from 'vitest';
import type { Request } from 'express';
import { captureServerError, redactedRoute } from '../../src/monitoring/capture-server-error';
import { setSentryClient, resetSentryClient, SentryClient, SentryScope, SentryTransaction } from '../../src/monitoring/sentry';
import { AppError } from '../../src/shared/errors';

function makeFakeClient() {
  const calls = { tags: [] as Array<[string, string]>, captured: [] as unknown[] };
  const client: SentryClient = {
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
  return { client, calls };
}

function fakeReq(overrides: Record<string, unknown>): Request {
  return { path: '/', originalUrl: '', ...overrides } as unknown as Request;
}

describe('redactedRoute', () => {
  it('prefers the route request logging already redacted', () => {
    const req = fakeReq({
      originalUrl: '/public/estimates/SECRET-TOKEN/accept',
      safeRequestLog: { route: '/public/estimates/[REDACTED]/accept' },
    });
    expect(redactedRoute(req)).toBe('/public/estimates/[REDACTED]/accept');
  });

  it('scrubs a token path segment and drops the query when request logging never ran', () => {
    const req = fakeReq({
      path: '/public/estimates/SECRET-TOKEN/accept',
      originalUrl: '/public/estimates/SECRET-TOKEN/accept?token=QUERY-SECRET&tier=2',
    });
    const route = redactedRoute(req);
    // #1205 — the query string is dropped entirely, not just token-scrubbed.
    expect(route).toBe('/public/estimates/[REDACTED]/accept');
    expect(route).not.toContain('SECRET');
  });

  it('falls back to req.path when originalUrl is empty', () => {
    expect(redactedRoute(fakeReq({ path: '/api/jobs' }))).toBe('/api/jobs');
  });
});

describe('captureServerError', () => {
  afterEach(() => resetSentryClient());

  it('never tags Sentry with a raw token route (tags bypass beforeSend)', () => {
    const { client, calls } = makeFakeClient();
    setSentryClient(client);
    // No safeRequestLog: the request never passed request logging, so the
    // path-segment token would have been tagged raw before the fix.
    const req = fakeReq({
      path: '/public/invoices/PATH-SECRET/pay',
      originalUrl: '/public/invoices/PATH-SECRET/pay?token=QUERY-SECRET',
      auth: { tenantId: 'tenant-1' },
    });

    captureServerError(new Error('boom'), req);

    expect(calls.captured).toHaveLength(1);
    const route = calls.tags.find(([k]) => k === 'route')?.[1];
    expect(route).toBe('/public/invoices/[REDACTED]/pay');
    expect(JSON.stringify(calls.tags)).not.toContain('SECRET');
    expect(calls.tags).toContainEqual(['tenant_id', 'tenant-1']);
  });
});

describe('#1205 — route tag never carries the query string', () => {
  afterEach(() => resetSentryClient());

  it('a 500 on a customer search does not put the searched name/phone in the route tag', () => {
    const { client, calls } = makeFakeClient();
    setSentryClient(client);
    const req = fakeReq({
      path: '/',
      originalUrl: '/api/customers?search=Jane%20Doe%20602-555-0199',
      // request logging ran and redacted only token-like params
      safeRequestLog: { route: '/api/customers?search=Jane%20Doe%20602-555-0199' },
    });

    captureServerError(new Error('boom'), req);

    const route = calls.tags.find(([k]) => k === 'route')?.[1];
    expect(route).toBe('/api/customers');
    expect(JSON.stringify(calls.tags)).not.toMatch(/Jane|602-555/);
  });
});

// A4-1 — a route that re-words an error for the owner (resolve-entity's
// ownerFacingPickError) keeps the original as the AppError's `cause`. The
// response shows the re-wording; Sentry must get the failure that happened.
describe('A4-1 — an AppError that re-words another error is reported as that error', () => {
  afterEach(() => resetSentryClient());

  it('reports the cause, with its own code and message, not the owner copy', () => {
    const { client, calls } = makeFakeClient();
    setSentryClient(client);
    const original = new AppError(
      'LLM_PROVIDER_UNAVAILABLE',
      'All providers failed. Last error: upstream 503',
      503,
      { providerPath: ['api.openai.com:gpt-4o-mini'] },
    );
    const reworded = new AppError(
      'LLM_PROVIDER_UNAVAILABLE',
      'That could not be finished right now. Please try again.',
      503,
      undefined,
      { cause: original },
    );

    captureServerError(reworded, fakeReq({ path: '/api/proposals/p-1/resolve-entity' }));

    expect(calls.captured).toHaveLength(1);
    expect(calls.captured[0]).toBe(original);
    expect((calls.captured[0] as AppError).code).toBe('LLM_PROVIDER_UNAVAILABLE');
    expect((calls.captured[0] as AppError).message).toBe('All providers failed. Last error: upstream 503');
  });

  it('follows a re-wording of a re-wording down to the error that happened', () => {
    const { client, calls } = makeFakeClient();
    setSentryClient(client);
    const original = new Error('connect ECONNREFUSED 10.0.0.7:443');
    const inner = new AppError('UPSTREAM_DOWN', 'Upstream down', 502, undefined, { cause: original });
    const outer = new AppError('UPSTREAM_DOWN', 'Please try again.', 502, undefined, { cause: inner });

    captureServerError(outer, fakeReq({ path: '/api/x' }));

    expect(calls.captured).toEqual([original]);
  });

  it('an AppError with no cause, and a plain Error that has one, are reported as they are', () => {
    const { client, calls } = makeFakeClient();
    setSentryClient(client);
    const plain = new AppError('INTERNAL', 'boom', 500);
    // A plain Error wrapping another adds its own context; Sentry links the
    // cause itself, so the wrapper stays the reported error.
    const wrapper = new Error('saving the summary failed', { cause: new Error('insert failed') });

    captureServerError(plain, fakeReq({ path: '/api/x' }));
    captureServerError(wrapper, fakeReq({ path: '/api/y' }));

    expect(calls.captured).toEqual([plain, wrapper]);
  });
});
