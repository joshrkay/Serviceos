import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { devAuthBypass, DevInMemoryTenantRepository } from '../../src/auth/dev-auth-bypass';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Response, NextFunction } from 'express';

/** Build an unsigned `header.payload.sig` JWT with the given claims. */
function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

async function run(claims: Record<string, unknown>) {
  const repo = new DevInMemoryTenantRepository();
  const mw = devAuthBypass({ tenantRepo: repo });
  const req = {
    headers: { authorization: `Bearer ${unsignedJwt(claims)}` },
  } as unknown as AuthenticatedRequest;
  let called = false;
  const next: NextFunction = () => {
    called = true;
  };
  await mw(req, {} as Response, next);
  return { req, called };
}

describe('devAuthBypass — role claim', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
  });
  afterEach(() => {
    delete process.env.DEV_AUTH_BYPASS;
  });

  it('defaults to owner when no role claim is present', async () => {
    const { req, called } = await run({ sub: 'u1' });
    expect(called).toBe(true);
    expect(req.auth?.role).toBe('owner');
    expect(req.auth?.userId).toBe('u1');
    expect(req.auth?.tenantId).toBeTruthy();
  });

  it('honors a valid technician role claim', async () => {
    const { req } = await run({ sub: 'u2', role: 'technician' });
    expect(req.auth?.role).toBe('technician');
  });

  it('honors a valid dispatcher role claim', async () => {
    const { req } = await run({ sub: 'u3', role: 'dispatcher' });
    expect(req.auth?.role).toBe('dispatcher');
  });

  it('falls back to owner for an unknown role rather than locking the session out', async () => {
    const { req } = await run({ sub: 'u4', role: 'superadmin' });
    expect(req.auth?.role).toBe('owner');
  });

  it('no-ops (no auth attached) when the bypass flag is off', async () => {
    process.env.DEV_AUTH_BYPASS = 'false';
    const { req, called } = await run({ sub: 'u5', role: 'technician' });
    expect(called).toBe(true);
    expect(req.auth).toBeUndefined();
  });
});
