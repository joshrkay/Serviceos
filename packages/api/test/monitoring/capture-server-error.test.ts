import { describe, it, expect, afterEach } from 'vitest';
import type { Request } from 'express';
import { captureServerError, redactedRoute } from '../../src/monitoring/capture-server-error';
import { setSentryClient, resetSentryClient, SentryClient, SentryScope, SentryTransaction } from '../../src/monitoring/sentry';

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

  it('scrubs a token path segment and ?token= when request logging never ran', () => {
    const req = fakeReq({
      path: '/public/estimates/SECRET-TOKEN/accept',
      originalUrl: '/public/estimates/SECRET-TOKEN/accept?token=QUERY-SECRET&tier=2',
    });
    const route = redactedRoute(req);
    expect(route).toBe('/public/estimates/[REDACTED]/accept?token=[REDACTED]&tier=2');
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
    expect(route).toBe('/public/invoices/[REDACTED]/pay?token=[REDACTED]');
    expect(JSON.stringify(calls.tags)).not.toContain('SECRET');
    expect(calls.tags).toContainEqual(['tenant_id', 'tenant-1']);
  });
});
