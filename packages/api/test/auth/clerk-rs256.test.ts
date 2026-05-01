import * as crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import {
  AuthenticatedRequest,
  JwksKey,
  JwksResolver,
  clerkFrontendApiFromPubKey,
  verifyClerkSession,
  verifyRs256Token,
} from '../../src/auth/clerk';

// ─────────────────────────────────────────────────────────────────────────────
// P0-033 — RS256 + JWKS verification for Clerk session tokens.
//
// We avoid network mocking. The verifier accepts an injected `JwksResolver`,
// so the tests construct a synthetic resolver that returns an in-process
// public key. This keeps the auth path testable without msw/nock/HTTP.
// ─────────────────────────────────────────────────────────────────────────────

const TEST_HOST = 'clerk.example.test';
const TEST_ISSUER = `https://${TEST_HOST}`;
// Clerk's publishable key encodes the host as base64 with a trailing '$'.
// We construct one that decodes to TEST_HOST so the default host derivation
// path also works in tests that don't override `host`.
const TEST_PUB_KEY = `pk_test_${Buffer.from(TEST_HOST + '$', 'utf-8').toString('base64')}`;

interface TestKey {
  kid: string;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
}

function generateTestKey(kid: string): TestKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return { kid, privateKey, publicKey };
}

function signRs256(
  payload: Record<string, unknown>,
  key: TestKey,
  options: { headerOverrides?: Record<string, unknown> } = {}
): string {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: key.kid,
    ...(options.headerOverrides ?? {}),
  };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(key.privateKey).toString('base64url');
  return `${signingInput}.${sig}`;
}

/**
 * In-process resolver that returns whatever keys are registered. Tracks fetch
 * count + forceRefresh count so tests can assert caching/refresh semantics.
 */
class StubResolver implements JwksResolver {
  public calls: Array<{ host: string; forceRefresh: boolean }> = [];
  constructor(private keys: JwksKey[]) {}

  setKeys(keys: JwksKey[]): void {
    this.keys = keys;
  }

  async getKeys(host: string, forceRefresh = false): Promise<JwksKey[]> {
    this.calls.push({ host, forceRefresh });
    return this.keys;
  }
}

function makeJwksKey(testKey: TestKey): JwksKey {
  return { kid: testKey.kid, publicKey: testKey.publicKey, alg: 'RS256' };
}

function defaultPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'user_rs256',
    sid: 'sess_rs256',
    iss: TEST_ISSUER,
    azp: 'https://app.example.com',
    iat: now,
    nbf: now - 1,
    exp: now + 3600,
    tenant_id: 'tenant_rs256',
    role: 'owner',
    ...overrides,
  };
}

describe('P0-033 — verifyClerkSession RS256 verification', () => {
  describe('verifyRs256Token', () => {
    it('happy path — valid RS256 token verifies (test JWKS server)', async () => {
      const key = generateTestKey('kid-1');
      const resolver = new StubResolver([makeJwksKey(key)]);
      const token = signRs256(defaultPayload(), key);

      const result = await verifyRs256Token(token, {
        pubKey: TEST_PUB_KEY,
        resolver,
        host: TEST_HOST,
      });

      expect(result.sub).toBe('user_rs256');
      expect(result.sid).toBe('sess_rs256');
      expect(result.tenant_id).toBe('tenant_rs256');
      expect(result.role).toBe('owner');
    });

    it('RS256 — wrong signature rejected', async () => {
      const key = generateTestKey('kid-1');
      const otherKey = generateTestKey('kid-1'); // same kid, different keypair
      const resolver = new StubResolver([makeJwksKey(otherKey)]);
      // Sign with `key` but JWKS only contains `otherKey`'s public — verify fails.
      const token = signRs256(defaultPayload(), key);

      await expect(
        verifyRs256Token(token, { pubKey: TEST_PUB_KEY, resolver, host: TEST_HOST })
      ).rejects.toThrow('Invalid token signature');
    });

    it('RS256 — expired token rejected', async () => {
      const key = generateTestKey('kid-1');
      const resolver = new StubResolver([makeJwksKey(key)]);
      const token = signRs256(
        defaultPayload({ exp: Math.floor(Date.now() / 1000) - 60 }),
        key
      );

      await expect(
        verifyRs256Token(token, { pubKey: TEST_PUB_KEY, resolver, host: TEST_HOST })
      ).rejects.toThrow('Token expired');
    });

    it('RS256 — wrong issuer rejected', async () => {
      const key = generateTestKey('kid-1');
      const resolver = new StubResolver([makeJwksKey(key)]);
      const token = signRs256(
        defaultPayload({ iss: 'https://attacker.example.com' }),
        key
      );

      await expect(
        verifyRs256Token(token, { pubKey: TEST_PUB_KEY, resolver, host: TEST_HOST })
      ).rejects.toThrow('Wrong issuer');
    });

    it('RS256 — kid not in JWKS triggers one refresh, then rejects if still missing', async () => {
      const signingKey = generateTestKey('kid-rotated');
      const resolver = new StubResolver([]); // empty JWKS at first
      const token = signRs256(defaultPayload(), signingKey);

      await expect(
        verifyRs256Token(token, { pubKey: TEST_PUB_KEY, resolver, host: TEST_HOST })
      ).rejects.toThrow('No matching signing key for token kid');

      // First call: cache lookup (forceRefresh=false). Second call: refresh.
      expect(resolver.calls).toHaveLength(2);
      expect(resolver.calls[0]).toEqual({ host: TEST_HOST, forceRefresh: false });
      expect(resolver.calls[1]).toEqual({ host: TEST_HOST, forceRefresh: true });
    });

    it('RS256 — kid miss recovers when the refresh returns the rotated key', async () => {
      const oldKey = generateTestKey('kid-old');
      const newKey = generateTestKey('kid-new');
      // Resolver starts with old key; on refresh it returns the new key.
      let returnNew = false;
      const resolver: JwksResolver = {
        async getKeys(_host, forceRefresh) {
          if (forceRefresh) returnNew = true;
          return returnNew ? [makeJwksKey(newKey)] : [makeJwksKey(oldKey)];
        },
      };
      const token = signRs256(defaultPayload(), newKey);

      const result = await verifyRs256Token(token, {
        pubKey: TEST_PUB_KEY,
        resolver,
        host: TEST_HOST,
      });
      expect(result.sub).toBe('user_rs256');
    });

    it('RS256 — rejects HS256 algorithm (algorithm-confusion defense)', async () => {
      const key = generateTestKey('kid-1');
      const resolver = new StubResolver([makeJwksKey(key)]);
      const headerB64 = Buffer.from(
        JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'kid-1' })
      ).toString('base64url');
      const payloadB64 = Buffer.from(JSON.stringify(defaultPayload())).toString('base64url');
      const sig = crypto
        .createHmac('sha256', 'secret')
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url');
      const token = `${headerB64}.${payloadB64}.${sig}`;

      await expect(
        verifyRs256Token(token, { pubKey: TEST_PUB_KEY, resolver, host: TEST_HOST })
      ).rejects.toThrow('Unsupported token algorithm');
    });
  });

  describe('JWKS cache hit (no second HTTP fetch within TTL)', () => {
    // We can't directly observe the singleton HttpsJwksResolver's network
    // calls without mocking fetch, but we CAN observe the resolver contract:
    // the verifier should call `getKeys(host, false)` once per token and only
    // call again with `forceRefresh: true` on a kid miss. So back-to-back
    // verifications of valid tokens result in exactly one cache-lookup call
    // each — both with forceRefresh=false (the resolver itself returns from
    // its TTL cache without re-fetching).
    it('does not force-refresh when the token kid is already known', async () => {
      const key = generateTestKey('kid-1');
      const resolver = new StubResolver([makeJwksKey(key)]);
      const token = signRs256(defaultPayload(), key);

      await verifyRs256Token(token, {
        pubKey: TEST_PUB_KEY,
        resolver,
        host: TEST_HOST,
      });
      await verifyRs256Token(token, {
        pubKey: TEST_PUB_KEY,
        resolver,
        host: TEST_HOST,
      });

      // Two verifications, each made one cache-hit getKeys call.
      // Crucially: zero forceRefresh calls because the kid was found.
      expect(resolver.calls).toHaveLength(2);
      expect(resolver.calls.every((c) => c.forceRefresh === false)).toBe(true);
    });
  });

  describe('clerkFrontendApiFromPubKey', () => {
    it('happy path — decodes pk_test_<base64> to host', () => {
      expect(clerkFrontendApiFromPubKey(TEST_PUB_KEY)).toBe(TEST_HOST);
    });

    it('happy path — decodes pk_live_<base64> to host', () => {
      const liveKey = `pk_live_${Buffer.from('clerk.acme.com$', 'utf-8').toString('base64')}`;
      expect(clerkFrontendApiFromPubKey(liveKey)).toBe('clerk.acme.com');
    });

    it('rejects a non-publishable-key string', () => {
      expect(() => clerkFrontendApiFromPubKey('sk_live_xxx')).toThrow(
        'not a Clerk publishable key'
      );
    });
  });

  describe('verifyClerkSession middleware — RS256 path', () => {
    function makeReq(token?: string): AuthenticatedRequest {
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      return {
        headers,
        ip: '127.0.0.1',
        path: '/api/test',
      } as unknown as AuthenticatedRequest;
    }

    function runMiddleware(
      mw: ReturnType<typeof verifyClerkSession>,
      req: AuthenticatedRequest
    ): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const next: NextFunction = (err?: unknown) => {
          if (err) return reject(err);
          resolve();
        };
        mw(req, {} as Response, next).catch(reject);
      });
    }

    it('happy path — sets req.auth from a valid RS256 token', async () => {
      const key = generateTestKey('kid-1');
      const resolver = new StubResolver([makeJwksKey(key)]);
      const token = signRs256(defaultPayload(), key);

      const mw = verifyClerkSession('unused-secret', {
        jwksResolver: resolver,
        publishableKey: TEST_PUB_KEY,
        env: { NODE_ENV: 'staging' }, // ensure HMAC dev path is OFF
      });
      const req = makeReq(token);
      await runMiddleware(mw, req);

      expect(req.auth).toEqual({
        userId: 'user_rs256',
        sessionId: 'sess_rs256',
        tenantId: 'tenant_rs256',
        role: 'owner',
      });
      expect(req.authError).toBeUndefined();
    });

    it('wrong signature — does not set req.auth and records authError', async () => {
      const key = generateTestKey('kid-1');
      const otherKey = generateTestKey('kid-1');
      const resolver = new StubResolver([makeJwksKey(otherKey)]);
      const token = signRs256(defaultPayload(), key);

      const mw = verifyClerkSession('unused-secret', {
        jwksResolver: resolver,
        publishableKey: TEST_PUB_KEY,
        env: { NODE_ENV: 'staging' },
      });
      const req = makeReq(token);
      await runMiddleware(mw, req);

      expect(req.auth).toBeUndefined();
      expect(req.authError).toBe('Invalid token signature');
    });

    it('HMAC dev path active only with CLERK_DEV_HMAC_TOKENS=true', async () => {
      // Build an HMAC-signed token with the legacy shape.
      const secret = 'shared-secret';
      const payload = {
        sub: 'user_hmac',
        sid: 'sess_hmac',
        tenant_id: 'tenant_hmac',
        role: 'owner',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
        'base64url'
      );
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url');
      const token = `${headerB64}.${payloadB64}.${sig}`;

      // Flag ON, dev env → HMAC accepted.
      const resolverNeverCalled = new StubResolver([]);
      const onMw = verifyClerkSession(secret, {
        jwksResolver: resolverNeverCalled,
        publishableKey: TEST_PUB_KEY,
        env: { NODE_ENV: 'dev', CLERK_DEV_HMAC_TOKENS: 'true' },
      });
      const onReq: AuthenticatedRequest = makeReq(token);
      await runMiddleware(onMw, onReq);
      expect(onReq.auth?.userId).toBe('user_hmac');
      expect(resolverNeverCalled.calls).toHaveLength(0); // no JWKS lookup happened

      // Flag OFF (absent) → HMAC token rejected because RS256 path is used.
      const resolverEmpty = new StubResolver([]);
      const offMw = verifyClerkSession(secret, {
        jwksResolver: resolverEmpty,
        publishableKey: TEST_PUB_KEY,
        env: { NODE_ENV: 'dev' },
      });
      const offReq: AuthenticatedRequest = makeReq(token);
      await runMiddleware(offMw, offReq);
      expect(offReq.auth).toBeUndefined();
      expect(offReq.authError).toBeTruthy();
    });

    it('HMAC dev path rejected in production env even when flag is true', async () => {
      const secret = 'shared-secret';
      const payload = {
        sub: 'user_hmac',
        sid: 'sess_hmac',
        tenant_id: 'tenant_hmac',
        role: 'owner',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
        'base64url'
      );
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url');
      const token = `${headerB64}.${payloadB64}.${sig}`;

      const resolverEmpty = new StubResolver([]);
      const mw = verifyClerkSession(secret, {
        jwksResolver: resolverEmpty,
        publishableKey: TEST_PUB_KEY,
        env: { NODE_ENV: 'production', CLERK_DEV_HMAC_TOKENS: 'true' },
      });
      const req = makeReq(token);
      await runMiddleware(mw, req);

      // Even with the flag set, prod NODE_ENV forces RS256 — and this token
      // is HS256 so it's rejected. Defense in depth at the runtime layer.
      expect(req.auth).toBeUndefined();
      expect(req.authError).toBeTruthy();
    });

    it('also rejects when NODE_ENV=prod (Railway alias)', async () => {
      const resolverEmpty = new StubResolver([]);
      const mw = verifyClerkSession('secret', {
        jwksResolver: resolverEmpty,
        publishableKey: TEST_PUB_KEY,
        env: { NODE_ENV: 'prod', CLERK_DEV_HMAC_TOKENS: 'true' },
      });
      // Force the RS256 path to run by using an RS256 token whose key is missing.
      const key = generateTestKey('kid-x');
      const token = signRs256(defaultPayload(), key);
      const req = makeReq(token);
      await runMiddleware(mw, req);
      expect(req.auth).toBeUndefined();
      // Confirms RS256 path was taken (HMAC path would have decoded happily).
      expect(req.authError).toBe('No matching signing key for token kid');
    });

    it('no Authorization header — calls next without setting req.auth', async () => {
      const mw = verifyClerkSession('secret', {
        jwksResolver: new StubResolver([]),
        publishableKey: TEST_PUB_KEY,
        env: { NODE_ENV: 'dev' },
      });
      const req = {
        headers: {} as Record<string, string>,
        ip: '127.0.0.1',
        path: '/api/test',
      } as unknown as AuthenticatedRequest;
      await runMiddleware(mw, req);
      expect(req.auth).toBeUndefined();
      expect(req.authError).toBeUndefined();
    });
  });
});
