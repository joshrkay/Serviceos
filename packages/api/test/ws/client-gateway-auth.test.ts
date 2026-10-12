/**
 * Client WebSocket gateway auth (/api/ws) — DB-authoritative membership gate,
 * production-guarded HMAC branch, and the end-to-end close-on-revocation path
 * over a real socket.
 */
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import {
  createClientGatewayAuth,
  extractClientGatewayToken,
} from '../../src/ws/client-gateway-auth';
import { attachClientGateway } from '../../src/ws/client-gateway';
import { InMemoryConnectionRegistry } from '../../src/ws/connection-registry';
import {
  decideMembership,
  setAuthorizationLoader,
  type MembershipDecision,
  type MembershipRecord,
} from '../../src/middleware/auth';
import type { ClerkTokenPayload } from '../../src/auth/clerk';

const PAYLOAD: ClerkTokenPayload = {
  sub: 'user_clerk_1',
  sid: 'sess_1',
  tenant_id: 'tenant-1',
  role: 'owner',
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const ACTIVE: MembershipRecord = {
  userId: 'canon-1',
  role: 'technician',
  status: 'active',
  deleted: false,
};

function reqWithToken(token = 'tok'): http.IncomingMessage {
  return {
    url: `/api/ws?token=${token}`,
    headers: {},
  } as unknown as http.IncomingMessage;
}

function decideReturning(d: MembershipDecision) {
  return vi.fn(async () => d);
}

function hmacToken(payload: object, secret: string): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

const PROD_ENV = { NODE_ENV: 'production', CLERK_PUBLISHABLE_KEY: 'pk' } as NodeJS.ProcessEnv;

describe('extractClientGatewayToken', () => {
  it('reads Bearer header, ?token= and bearer.<tok> subprotocol', () => {
    const mk = (url: string, headers: Record<string, string>) =>
      ({ url, headers }) as unknown as http.IncomingMessage;
    expect(extractClientGatewayToken(mk('/api/ws', { authorization: 'Bearer h' }))).toBe('h');
    expect(extractClientGatewayToken(mk('/api/ws?token=q', {}))).toBe('q');
    expect(
      extractClientGatewayToken(mk('/api/ws', { 'sec-websocket-protocol': 'v1, bearer.p' })),
    ).toBe('p');
    expect(extractClientGatewayToken(mk('/api/ws', {}))).toBeUndefined();
  });
});

describe('createClientGatewayAuth — membership gate at connect', () => {
  const verifyRs256 = vi.fn(async () => PAYLOAD);

  it('rejects a suspended / deleted (revoked) membership', async () => {
    for (const membership of [
      { ...ACTIVE, status: 'suspended' },
      { ...ACTIVE, deleted: true },
    ]) {
      const auth = createClientGatewayAuth({
        env: PROD_ENV,
        verifyRs256,
        decide: decideReturning({ outcome: 'revoked', membership }),
      });
      expect(await auth.authenticate(reqWithToken())).toBeNull();
    }
  });

  it('rejects a missing membership row and fails closed when the loader is unavailable', async () => {
    const none = createClientGatewayAuth({
      env: PROD_ENV,
      verifyRs256,
      decide: decideReturning({ outcome: 'no_membership' }),
    });
    expect(await none.authenticate(reqWithToken())).toBeNull();

    const down = createClientGatewayAuth({
      env: PROD_ENV,
      verifyRs256,
      decide: decideReturning({ outcome: 'unavailable', error: new Error('db down') }),
    });
    expect(await down.authenticate(reqWithToken())).toBeNull();
  });

  it('accepts an active member with the DB role (not the token claim) and the token exp', async () => {
    const decide = decideReturning({ outcome: 'allowed', membership: ACTIVE });
    const auth = createClientGatewayAuth({ env: PROD_ENV, verifyRs256, decide });
    const result = await auth.authenticate(reqWithToken());
    expect(decide).toHaveBeenCalledWith('user_clerk_1', 'tenant-1');
    expect(result).toEqual({
      tenantId: 'tenant-1',
      userId: 'user_clerk_1',
      role: 'technician',
      expiresAtMs: PAYLOAD.exp * 1000,
    });
  });

  it('keeps the token claim when no loader is wired (same as HTTP)', async () => {
    const auth = createClientGatewayAuth({
      env: PROD_ENV,
      verifyRs256,
      decide: decideReturning({ outcome: 'unchecked' }),
    });
    expect((await auth.authenticate(reqWithToken()))?.role).toBe('owner');
  });

  it('rejects an unverifiable token without consulting membership', async () => {
    const decide = decideReturning({ outcome: 'allowed', membership: ACTIVE });
    const auth = createClientGatewayAuth({
      env: PROD_ENV,
      verifyRs256: async () => {
        throw new Error('bad sig');
      },
      decide,
    });
    expect(await auth.authenticate(reqWithToken())).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('uses the real decideMembership + wired loader by default', async () => {
    const loader = vi.fn(async () => ({ ...ACTIVE, status: 'suspended' }));
    setAuthorizationLoader(loader);
    try {
      const auth = createClientGatewayAuth({ env: PROD_ENV, verifyRs256 });
      expect(await auth.authenticate(reqWithToken())).toBeNull();
      expect(loader).toHaveBeenCalledWith('user_clerk_1', 'tenant-1');
    } finally {
      setAuthorizationLoader(null);
    }
  });
});

describe('createClientGatewayAuth — revalidate', () => {
  const AUTH = { tenantId: 'tenant-1', userId: 'user_clerk_1' };
  it.each<[MembershipDecision, string]>([
    [{ outcome: 'allowed', membership: ACTIVE }, 'ok'],
    [{ outcome: 'unchecked' }, 'ok'],
    [{ outcome: 'no_membership' }, 'revoked'],
    [{ outcome: 'revoked', membership: { ...ACTIVE, status: 'suspended' } }, 'revoked'],
    [{ outcome: 'unavailable', error: new Error('x') }, 'unavailable'],
  ])('%o → %s', async (decision, expected) => {
    const auth = createClientGatewayAuth({ decide: decideReturning(decision) });
    expect(await auth.revalidate(AUTH)).toBe(expected);
  });

  it('treats a connection with no subject as revoked', async () => {
    const auth = createClientGatewayAuth({ decide: decideReturning({ outcome: 'unchecked' }) });
    expect(await auth.revalidate({ tenantId: 'tenant-1' })).toBe('revoked');
  });
});

describe('createClientGatewayAuth — HMAC dev-token branch guard', () => {
  const allow = decideReturning({ outcome: 'unchecked' });

  it('refuses the HMAC branch in production even with the dev flag + secret', async () => {
    const decodeHmac = vi.fn(() => PAYLOAD);
    const verifyRs256 = vi.fn(async () => {
      throw new Error('not rs256');
    });
    for (const NODE_ENV of ['production', 'prod']) {
      const auth = createClientGatewayAuth({
        env: { NODE_ENV, CLERK_DEV_HMAC_TOKENS: 'true', CLERK_SECRET_KEY: 's' },
        decodeHmac,
        verifyRs256,
        decide: allow,
      });
      expect(await auth.authenticate(reqWithToken())).toBeNull();
    }
    expect(decodeHmac).not.toHaveBeenCalled();
    expect(verifyRs256).toHaveBeenCalledTimes(2);
  });

  it('refuses the HMAC branch when the secret is empty or unset', async () => {
    // A token HMAC-signed with the empty string must never verify.
    const forged = hmacToken({ ...PAYLOAD }, '');
    const verifyRs256 = vi.fn(async () => {
      throw new Error('not rs256');
    });
    for (const env of [
      { NODE_ENV: 'development', CLERK_DEV_HMAC_TOKENS: 'true', CLERK_SECRET_KEY: '' },
      { NODE_ENV: 'development', CLERK_DEV_HMAC_TOKENS: 'true' },
    ]) {
      const auth = createClientGatewayAuth({ env, verifyRs256, decide: allow });
      expect(await auth.authenticate(reqWithToken(forged))).toBeNull();
    }
    expect(verifyRs256).toHaveBeenCalledTimes(2);
  });

  it('accepts a correctly signed HMAC token in dev with the flag and a secret', async () => {
    const token = hmacToken({ ...PAYLOAD }, 'dev-secret');
    const auth = createClientGatewayAuth({
      env: { NODE_ENV: 'development', CLERK_DEV_HMAC_TOKENS: 'true', CLERK_SECRET_KEY: 'dev-secret' },
      decide: allow,
    });
    expect((await auth.authenticate(reqWithToken(token)))?.tenantId).toBe('tenant-1');
  });
});

// ── End to end over a real socket ────────────────────────────────────
describe('client gateway + auth over a real WebSocket', () => {
  let server: http.Server | undefined;
  let handle: ReturnType<typeof attachClientGateway> | undefined;

  afterEach(async () => {
    handle?.dispose();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    handle = undefined;
  });

  async function start(decide: typeof decideMembership, revalidateIntervalMs = 50) {
    server = http.createServer();
    handle = attachClientGateway(server, {
      auth: createClientGatewayAuth({
        env: PROD_ENV,
        verifyRs256: async () => PAYLOAD,
        decide,
      }),
      registry: new InMemoryConnectionRegistry(),
      revalidateIntervalMs,
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return (server.address() as AddressInfo).port;
  }

  it('refuses the upgrade (401) for a suspended membership', async () => {
    const port = await start(
      decideReturning({ outcome: 'revoked', membership: { ...ACTIVE, status: 'suspended' } }),
    );
    const status = await new Promise<number | undefined>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=t`);
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode);
        ws.terminate();
      });
      ws.on('open', () => resolve(undefined));
      ws.on('error', () => {});
    });
    expect(status).toBe(401);
  });

  it('closes an open socket with 4403 once membership is revoked mid-session', async () => {
    let revoked = false;
    const decide = vi.fn(async (): Promise<MembershipDecision> =>
      revoked
        ? { outcome: 'revoked', membership: { ...ACTIVE, deleted: true } }
        : { outcome: 'allowed', membership: ACTIVE },
    );
    const port = await start(decide);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=t`);
    await new Promise<void>((r) => ws.on('open', () => r()));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    revoked = true;
    expect(await closed).toBe(4403);
  });
});
