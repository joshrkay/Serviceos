/**
 * CLERK-META-2026-09-27 — unit tests for the shared Clerk metadata client.
 *
 * fetch is injected per call; no network, no DB.
 */
import { describe, it, expect, vi } from 'vitest';
import { createLogger } from '../../src/logging/logger';
import {
  writeClerkUserMetadata,
  readClerkUserMetadata,
  describeClerkFailure,
  CLERK_API_TIMEOUT_MS,
} from '../../src/auth/clerk-user-metadata';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function okJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function errText(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => { throw new Error('no json'); },
    text: async () => body,
  } as Response;
}

describe('writeClerkUserMetadata', () => {
  it('PATCHes public_metadata and reports ok', async () => {
    const fetchFn = vi.fn(async () => okJson({ id: 'user_1' }));
    const result = await writeClerkUserMetadata(
      { secretKey: 'sk_test', fetchFn: fetchFn as unknown as typeof fetch, logger },
      'user_1',
      { tenant_id: 't-1', role: 'owner' },
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.clerk.com/v1/users/user_1');
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
    expect(JSON.parse(init.body as string)).toEqual({
      public_metadata: { tenant_id: 't-1', role: 'owner' },
    });
    // Bounded: a stalled Clerk upstream must not pin the caller.
    expect(init.signal).toBeDefined();
    expect(CLERK_API_TIMEOUT_MS).toBe(10_000);
  });

  it('URL-encodes the Clerk user id', async () => {
    const fetchFn = vi.fn(async () => okJson({}));
    await writeClerkUserMetadata(
      { secretKey: 'sk', fetchFn: fetchFn as unknown as typeof fetch, logger },
      'user a/b',
      { tenant_id: 't' },
    );
    const [url] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.clerk.com/v1/users/user%20a%2Fb');
  });

  it('surfaces non-ok statuses with the truncated error body', async () => {
    const fetchFn = vi.fn(async () => errText(500, 'upstream exploded'));
    const result = await writeClerkUserMetadata(
      { secretKey: 'sk', fetchFn: fetchFn as unknown as typeof fetch, logger },
      'user_1',
      { tenant_id: 't-1' },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.errorBody).toBe('upstream exploded');
    expect(describeClerkFailure(result)).toContain('HTTP 500');
  });

  it('maps a transport failure to status 0 with the error message', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('socket hangup'); });
    const result = await writeClerkUserMetadata(
      { secretKey: 'sk', fetchFn: fetchFn as unknown as typeof fetch, logger },
      'user_1',
      { tenant_id: 't-1' },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.transportError).toBe('socket hangup');
    expect(describeClerkFailure(result)).toContain('socket hangup');
  });
});

describe('readClerkUserMetadata', () => {
  it('returns public_metadata from the Clerk user', async () => {
    const fetchFn = vi.fn(async () =>
      okJson({ id: 'user_1', public_metadata: { tenant_id: 't-9', role: 'owner' } }),
    );
    const result = await readClerkUserMetadata(
      { secretKey: 'sk', fetchFn: fetchFn as unknown as typeof fetch, logger },
      'user_1',
    );
    expect(result.ok).toBe(true);
    expect(result.publicMetadata).toEqual({ tenant_id: 't-9', role: 'owner' });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBeUndefined(); // GET
  });

  it('defaults public_metadata to {} when Clerk omits it', async () => {
    const fetchFn = vi.fn(async () => okJson({ id: 'user_1' }));
    const result = await readClerkUserMetadata(
      { secretKey: 'sk', fetchFn: fetchFn as unknown as typeof fetch, logger },
      'user_1',
    );
    expect(result.ok).toBe(true);
    expect(result.publicMetadata).toEqual({});
  });

  it('surfaces a 404 for a deleted user', async () => {
    const fetchFn = vi.fn(async () => errText(404, '{"errors":[{"code":"not_found"}]}'));
    const result = await readClerkUserMetadata(
      { secretKey: 'sk', fetchFn: fetchFn as unknown as typeof fetch, logger },
      'user_gone',
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });
});
