/**
 * Review-monitoring self-serve — google-business-integration module.
 *
 * Pins the SINGLE credential shape shared by writer (connect flow) and
 * readers (poll worker + reply resolver) on `tenant_integrations`:
 *
 *   credentials = {
 *     accessTokenEnc:       AES-256-GCM via TENANT_ENCRYPTION_KEY,
 *     refreshTokenEnc:      AES-256-GCM via TENANT_ENCRYPTION_KEY,
 *     accessTokenExpiresAt: ISO timestamp,
 *     providerData: { accountId, locationId },
 *   }
 *
 * Also covers the shared refresh-on-401-retry-once wrapper the worker
 * uses (`callWithGoogleBusinessAuthRetry`).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  InMemoryGoogleBusinessIntegrationRepository,
  resolveGoogleBusinessTokens,
  resolveGoogleBusinessLocation,
  callWithGoogleBusinessAuthRetry,
  GOOGLE_BUSINESS_PROVIDER,
} from '../../src/reputation/google-business-integration';
import {
  GoogleBusinessAuthError,
} from '../../src/reputation/google-business-client';
import { decrypt } from '../../src/integrations/crypto';
import type { CredentialRow } from '../../src/integrations/credentials';

const TEST_KEY = '0'.repeat(64);
const TENANT = 'tenant-gbp-1';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('google-business-integration credential shape', () => {
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });

  it('upsert writes the worker-readable credentials JSON (encrypted tokens + providerData)', async () => {
    const repo = new InMemoryGoogleBusinessIntegrationRepository();
    await repo.upsert({
      tenantId: TENANT,
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      accessTokenExpiresAt: new Date('2026-08-05T13:00:00Z'),
      accountId: '123',
      locationId: '999',
    });

    // The repo doubles as a CredentialResolver so tests (and the sweep)
    // read the row exactly the way the production worker does.
    const row = await repo.getCredential(TENANT, GOOGLE_BUSINESS_PROVIDER);
    expect(row).not.toBeNull();
    const creds = row!.credentials as Record<string, unknown>;
    // Tokens are encrypted at rest — never plaintext.
    expect(creds.accessToken).toBeUndefined();
    expect(creds.refreshToken).toBeUndefined();
    expect(decrypt(creds.accessTokenEnc as string, TEST_KEY)).toBe('AT-1');
    expect(decrypt(creds.refreshTokenEnc as string, TEST_KEY)).toBe('RT-1');
    expect(creds.accessTokenExpiresAt).toBe('2026-08-05T13:00:00.000Z');
    expect(creds.providerData).toEqual({ accountId: '123', locationId: '999' });
  });

  it('resolveGoogleBusinessTokens reads the upserted row back (worker read path)', async () => {
    const repo = new InMemoryGoogleBusinessIntegrationRepository();
    await repo.upsert({
      tenantId: TENANT,
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      accessTokenExpiresAt: new Date('2026-08-05T13:00:00Z'),
      accountId: '123',
      locationId: '999',
    });
    const row = await repo.getCredential(TENANT, GOOGLE_BUSINESS_PROVIDER);
    const tokens = resolveGoogleBusinessTokens(row!, TEST_KEY);
    expect(tokens).toEqual({
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      expiresAt: new Date('2026-08-05T13:00:00.000Z'),
    });
    expect(resolveGoogleBusinessLocation(row!)).toEqual({
      accountId: '123',
      locationId: '999',
    });
  });

  it('persistRotatedAccessToken rotates only the access token, keeping the refresh token', async () => {
    const repo = new InMemoryGoogleBusinessIntegrationRepository();
    await repo.upsert({
      tenantId: TENANT,
      accessToken: 'AT-old',
      refreshToken: 'RT-keep',
      accessTokenExpiresAt: new Date('2026-08-05T13:00:00Z'),
      accountId: '123',
      locationId: '999',
    });
    await repo.persistRotatedAccessToken(
      TENANT,
      'AT-new',
      new Date('2026-08-05T14:00:00Z'),
    );
    const row = await repo.getCredential(TENANT, GOOGLE_BUSINESS_PROVIDER);
    const tokens = resolveGoogleBusinessTokens(row!, TEST_KEY);
    expect(tokens?.accessToken).toBe('AT-new');
    expect(tokens?.refreshToken).toBe('RT-keep');
    expect(tokens?.expiresAt).toEqual(new Date('2026-08-05T14:00:00.000Z'));
    // Rotation bumps credential_version so caches can invalidate.
    expect(row!.credential_version).toBe(2);
  });

  it('disconnect removes the row so the worker skips the tenant silently', async () => {
    const repo = new InMemoryGoogleBusinessIntegrationRepository();
    await repo.upsert({
      tenantId: TENANT,
      accessToken: 'AT',
      refreshToken: 'RT',
      accessTokenExpiresAt: new Date('2026-08-05T13:00:00Z'),
    });
    expect(await repo.disconnect(TENANT)).toBe(true);
    expect(await repo.getCredential(TENANT, GOOGLE_BUSINESS_PROVIDER)).toBeNull();
    expect(await repo.get(TENANT)).toBeNull();
    // Idempotent: second disconnect reports nothing to remove.
    expect(await repo.disconnect(TENANT)).toBe(false);
  });

  it('resolveGoogleBusinessTokens supports the legacy hand-seeded plaintext shape', () => {
    const row: CredentialRow = {
      tenant_id: TENANT,
      provider: GOOGLE_BUSINESS_PROVIDER,
      credentials: { accessToken: 'plain-at', accountId: 'A', locationId: 'L' },
      credential_version: 1,
    };
    const tokens = resolveGoogleBusinessTokens(row, undefined);
    expect(tokens).toEqual({
      accessToken: 'plain-at',
      refreshToken: null,
      expiresAt: null,
    });
    expect(resolveGoogleBusinessLocation(row)).toEqual({
      accountId: 'A',
      locationId: 'L',
    });
  });

  it('resolveGoogleBusinessTokens returns null when no token is recoverable', () => {
    const row: CredentialRow = {
      tenant_id: TENANT,
      provider: GOOGLE_BUSINESS_PROVIDER,
      credentials: { accessTokenEnc: 'garbage' },
      credential_version: 1,
    };
    expect(resolveGoogleBusinessTokens(row, TEST_KEY)).toBeNull();
    expect(resolveGoogleBusinessTokens(row, undefined)).toBeNull();
  });
});

describe('callWithGoogleBusinessAuthRetry (refresh on 401, retry once)', () => {
  const config = {
    clientId: 'cid',
    clientSecret: 'csec',
    redirectUri: 'https://api.example.com/cb',
  };

  it('passes through when the first call succeeds (no refresh)', async () => {
    const persist = vi.fn();
    const result = await callWithGoogleBusinessAuthRetry({
      tenantId: TENANT,
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: null },
      config,
      store: { persistRotatedAccessToken: persist },
      fetchFn: async () => jsonRes({}),
      call: async (at) => `ok:${at}`,
    });
    expect(result).toBe('ok:AT');
    expect(persist).not.toHaveBeenCalled();
  });

  it('on 401: refreshes, persists the rotated token, retries ONCE with the new token', async () => {
    const persist = vi.fn();
    const attempts: string[] = [];
    const tokenEndpoint = vi.fn(async () =>
      jsonRes({ access_token: 'AT-new', expires_in: 3600 }),
    );
    const result = await callWithGoogleBusinessAuthRetry({
      tenantId: TENANT,
      tokens: { accessToken: 'AT-stale', refreshToken: 'RT', expiresAt: null },
      config,
      store: { persistRotatedAccessToken: persist },
      fetchFn: tokenEndpoint as unknown as typeof fetch,
      call: async (at) => {
        attempts.push(at);
        if (at === 'AT-stale') throw new GoogleBusinessAuthError('expired');
        return `ok:${at}`;
      },
    });
    expect(result).toBe('ok:AT-new');
    expect(attempts).toEqual(['AT-stale', 'AT-new']);
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toBe(TENANT);
    expect(persist.mock.calls[0][1]).toBe('AT-new');
    expect(persist.mock.calls[0][2]).toBeInstanceOf(Date);
  });

  it('propagates GoogleBusinessAuthError when the refresh grant fails', async () => {
    const persist = vi.fn();
    await expect(
      callWithGoogleBusinessAuthRetry({
        tenantId: TENANT,
        tokens: { accessToken: 'AT-stale', refreshToken: 'RT-revoked', expiresAt: null },
        config,
        store: { persistRotatedAccessToken: persist },
        fetchFn: async () => jsonRes({ error: 'invalid_grant' }, 400),
        call: async () => {
          throw new GoogleBusinessAuthError('expired');
        },
      }),
    ).rejects.toThrow(GoogleBusinessAuthError);
    expect(persist).not.toHaveBeenCalled();
  });

  it('retries only once — a second 401 propagates', async () => {
    let calls = 0;
    await expect(
      callWithGoogleBusinessAuthRetry({
        tenantId: TENANT,
        tokens: { accessToken: 'AT-stale', refreshToken: 'RT', expiresAt: null },
        config,
        store: { persistRotatedAccessToken: async () => {} },
        fetchFn: async () => jsonRes({ access_token: 'AT-new', expires_in: 3600 }),
        call: async () => {
          calls++;
          throw new GoogleBusinessAuthError('still revoked upstream');
        },
      }),
    ).rejects.toThrow(GoogleBusinessAuthError);
    expect(calls).toBe(2);
  });

  it('propagates immediately when there is no refresh token or no config', async () => {
    let calls = 0;
    await expect(
      callWithGoogleBusinessAuthRetry({
        tenantId: TENANT,
        tokens: { accessToken: 'AT', refreshToken: null, expiresAt: null },
        config,
        store: null,
        call: async () => {
          calls++;
          throw new GoogleBusinessAuthError('expired');
        },
      }),
    ).rejects.toThrow(GoogleBusinessAuthError);
    expect(calls).toBe(1);

    await expect(
      callWithGoogleBusinessAuthRetry({
        tenantId: TENANT,
        tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: null },
        config: null,
        store: null,
        call: async () => {
          throw new GoogleBusinessAuthError('expired');
        },
      }),
    ).rejects.toThrow(GoogleBusinessAuthError);
  });

  it('non-auth errors pass through untouched (no refresh attempt)', async () => {
    const tokenEndpoint = vi.fn();
    await expect(
      callWithGoogleBusinessAuthRetry({
        tenantId: TENANT,
        tokens: { accessToken: 'AT', refreshToken: 'RT', expiresAt: null },
        config,
        store: null,
        fetchFn: tokenEndpoint as unknown as typeof fetch,
        call: async () => {
          throw new Error('500 from Google');
        },
      }),
    ).rejects.toThrow('500 from Google');
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });
});
