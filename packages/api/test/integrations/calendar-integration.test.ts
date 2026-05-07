import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  InMemoryCalendarIntegrationRepository,
  InMemoryOAuthStateRepository,
  decryptAccessToken,
  decryptRefreshToken,
} from '../../src/integrations/calendar-integration';
import {
  buildGoogleAuthUrl,
  exchangeAuthorizationCode,
  getValidAccessToken,
} from '../../src/integrations/google-calendar';

const TEST_KEY = '0'.repeat(64); // 32-byte hex key

describe('CalendarIntegration repos + Google OAuth helpers (PR 1)', () => {
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });

  describe('InMemoryCalendarIntegrationRepository', () => {
    let repo: InMemoryCalendarIntegrationRepository;
    beforeEach(() => {
      repo = new InMemoryCalendarIntegrationRepository();
    });

    it('upserts a row with encrypted tokens', async () => {
      const row = await repo.upsert({
        tenantId: 'tenant-1',
        userId: 'user-1',
        provider: 'google',
        accessToken: 'access-tok-123',
        refreshToken: 'refresh-tok-456',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountEmail: 'user@example.com',
      });
      expect(row.status).toBe('active');
      expect(row.calendarId).toBe('primary');
      // Tokens are stored encrypted; raw plaintext should not match.
      expect(row.accessTokenEncrypted).not.toContain('access-tok-123');
      // But round-trip via decrypt helpers.
      expect(decryptAccessToken(row)).toBe('access-tok-123');
      expect(decryptRefreshToken(row)).toBe('refresh-tok-456');
    });

    it('upsert is keyed on (tenant, user, provider) and overwrites', async () => {
      const a = await repo.upsert({
        tenantId: 'tenant-1', userId: 'user-1', provider: 'google',
        accessToken: 'a1', refreshToken: 'r1',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountEmail: 'user@example.com',
      });
      const b = await repo.upsert({
        tenantId: 'tenant-1', userId: 'user-1', provider: 'google',
        accessToken: 'a2', refreshToken: 'r2',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountEmail: 'user@example.com',
      });
      expect(b.id).toBe(a.id);
      expect(decryptAccessToken(b)).toBe('a2');
    });

    it('revoke flips status to revoked but keeps the row', async () => {
      await repo.upsert({
        tenantId: 'tenant-1', userId: 'user-1', provider: 'google',
        accessToken: 'a', refreshToken: 'r',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountEmail: 'user@example.com',
      });
      const ok = await repo.revoke('tenant-1', 'user-1', 'google');
      expect(ok).toBe(true);
      const after = await repo.findByUser('tenant-1', 'user-1', 'google');
      expect(after?.status).toBe('revoked');
    });

    it('findActiveByTenant excludes revoked + expired rows', async () => {
      const a = await repo.upsert({
        tenantId: 'tenant-1', userId: 'user-1', provider: 'google',
        accessToken: 'a', refreshToken: 'r',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountEmail: 'a@example.com',
      });
      const b = await repo.upsert({
        tenantId: 'tenant-1', userId: 'user-2', provider: 'google',
        accessToken: 'a', refreshToken: 'r',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountEmail: 'b@example.com',
      });
      await repo.setStatus('tenant-1', b.id, 'expired');
      void a;
      const active = await repo.findActiveByTenant('tenant-1');
      expect(active.map((r) => r.userId)).toEqual(['user-1']);
    });
  });

  describe('InMemoryOAuthStateRepository', () => {
    it('atomic consume returns the row once and refuses replay', async () => {
      const repo = new InMemoryOAuthStateRepository();
      const { id } = await repo.create({
        tenantId: 'tenant-1', userId: 'user-1', provider: 'google',
      });
      const first = await repo.consume(id);
      expect(first?.tenantId).toBe('tenant-1');
      const replay = await repo.consume(id);
      expect(replay).toBeNull();
    });

    it('refuses an unknown state id', async () => {
      const repo = new InMemoryOAuthStateRepository();
      const result = await repo.consume('unknown-id');
      expect(result).toBeNull();
    });
  });

  describe('buildGoogleAuthUrl', () => {
    it('includes scopes, state, prompt=consent, access_type=offline', () => {
      const url = buildGoogleAuthUrl(
        {
          clientId: 'cid',
          clientSecret: 'csec',
          redirectUri: 'https://api.example.com/callback',
        },
        'state-nonce-1',
      );
      expect(url).toContain('client_id=cid');
      expect(url).toContain('state=state-nonce-1');
      expect(url).toContain('access_type=offline');
      expect(url).toContain('prompt=consent');
      expect(url).toContain('calendar.events');
      expect(url).toContain('userinfo.email');
    });
  });

  describe('exchangeAuthorizationCode', () => {
    function jsonRes(body: unknown, status = 200): Response {
      return {
        ok: status < 400,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }

    it('exchanges the code and fetches userinfo for the email', async () => {
      const calls: Array<[string, RequestInit | undefined]> = [];
      const fakeFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        calls.push([String(input), init]);
        if (String(input).includes('/token')) {
          return jsonRes({
            access_token: 'AT123',
            refresh_token: 'RT456',
            expires_in: 3600,
          });
        }
        if (String(input).includes('/userinfo')) {
          return jsonRes({ email: 'user@example.com' });
        }
        return jsonRes({}, 404);
      };

      const tokens = await exchangeAuthorizationCode(
        {
          clientId: 'cid',
          clientSecret: 'csec',
          redirectUri: 'https://api.example.com/cb',
        },
        'auth-code-xyz',
        fakeFetch as typeof fetch,
      );
      expect(tokens.accessToken).toBe('AT123');
      expect(tokens.refreshToken).toBe('RT456');
      expect(tokens.email).toBe('user@example.com');
      expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // Verifies the userinfo call carries the access token.
      const userinfoCall = calls.find((c) => c[0].includes('/userinfo'));
      expect((userinfoCall![1]?.headers as Record<string, string>)['Authorization']).toContain(
        'AT123',
      );
    });

    it('throws when refresh_token is missing', async () => {
      const fakeFetch = async (): Promise<Response> => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'AT', expires_in: 3600 }),
        text: async () => '',
      } as unknown as Response);
      await expect(
        exchangeAuthorizationCode(
          { clientId: 'cid', clientSecret: 'csec', redirectUri: 'http://x' },
          'code',
          fakeFetch as typeof fetch,
        ),
      ).rejects.toThrow(/access \+ refresh tokens/);
    });
  });

  describe('getValidAccessToken', () => {
    it('returns the cached token when not near expiry', async () => {
      const repo = new InMemoryCalendarIntegrationRepository();
      const row = await repo.upsert({
        tenantId: 't', userId: 'u', provider: 'google',
        accessToken: 'cached-tok',
        refreshToken: 'r',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        externalAccountEmail: 'user@example.com',
      });
      const fakeFetch = async (): Promise<Response> => {
        throw new Error('should not be called');
      };
      const tok = await getValidAccessToken(
        row,
        { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
        repo,
        fakeFetch as typeof fetch,
      );
      expect(tok).toBe('cached-tok');
    });

    it('refreshes when within 60s of expiry, persists the new token', async () => {
      const repo = new InMemoryCalendarIntegrationRepository();
      const row = await repo.upsert({
        tenantId: 't', userId: 'u', provider: 'google',
        accessToken: 'old-tok',
        refreshToken: 'r-tok',
        accessTokenExpiresAt: new Date(Date.now() + 30_000),
        externalAccountEmail: 'user@example.com',
      });
      const fakeFetch = async (): Promise<Response> => ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'new-tok', expires_in: 3600 }),
        text: async () => '',
      } as unknown as Response);

      const tok = await getValidAccessToken(
        row,
        { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
        repo,
        fakeFetch as typeof fetch,
      );
      expect(tok).toBe('new-tok');
      // Persisted on the row.
      const refreshed = await repo.findByUser('t', 'u', 'google');
      expect(decryptAccessToken(refreshed!)).toBe('new-tok');
    });

    it('marks integration expired on invalid_grant (revoked refresh token)', async () => {
      const repo = new InMemoryCalendarIntegrationRepository();
      const row = await repo.upsert({
        tenantId: 't', userId: 'u', provider: 'google',
        accessToken: 'old',
        refreshToken: 'r-tok',
        accessTokenExpiresAt: new Date(Date.now() - 1000),
        externalAccountEmail: 'user@example.com',
      });
      const fakeFetch = async (): Promise<Response> => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
        text: async () => 'invalid_grant',
      } as unknown as Response);

      await expect(
        getValidAccessToken(
          row,
          { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
          repo,
          fakeFetch as typeof fetch,
        ),
      ).rejects.toThrow(/expired/i);

      const after = await repo.findByUser('t', 'u', 'google');
      expect(after?.status).toBe('expired');
    });
  });
});
