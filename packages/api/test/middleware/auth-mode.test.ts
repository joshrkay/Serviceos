/**
 * P12-001 — `requireTenant` extension that populates `req.auth.mode`.
 *
 * The middleware reads `users.current_mode` via an injected loader (so
 * the auth seam stays free of DB deps) and caches the result for 60s
 * keyed by `user_id`. These tests cover the two contract points the
 * story calls out:
 *
 *  - `req.auth.mode` is populated for a known user;
 *  - it defaults to `'supervisor'` for an unknown user (no row).
 */
import type { Response } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  requireTenant,
  setUserModeLoader,
  clearUserModeCacheForTests,
  type Mode,
} from '../../src/middleware/auth';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

function mockReqRes(auth?: AuthenticatedRequest['auth']) {
  const req = { auth } as AuthenticatedRequest;
  const resObj: any = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res: resObj as Response, next };
}

describe('P12-001 — requireTenant attaches req.auth.mode', () => {
  beforeEach(() => {
    setUserModeLoader(null);
    clearUserModeCacheForTests();
  });

  it('populates req.auth.mode from the loader for a known user', async () => {
    const calls: Array<{ userId: string; tenantId: string }> = [];
    setUserModeLoader(async (userId, tenantId) => {
      calls.push({ userId, tenantId });
      return 'tech' as Mode;
    });

    const { req, res, next } = mockReqRes({
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
      role: 'owner',
    });
    await requireTenant(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req.auth as { mode?: Mode }).mode).toBe('tech');
    expect(calls).toEqual([{ userId: 'user-1', tenantId: 'tenant-1' }]);
  });

  it("defaults to 'supervisor' when the loader returns null", async () => {
    setUserModeLoader(async () => null);

    const { req, res, next } = mockReqRes({
      userId: 'user-new',
      sessionId: 'sess-new',
      tenantId: 'tenant-1',
      role: 'dispatcher',
    });
    await requireTenant(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req.auth as { mode?: Mode }).mode).toBe('supervisor');
  });

  it("defaults to 'supervisor' when no loader is wired (legacy path)", async () => {
    // Loader cleared in beforeEach → simulates the dev path with no DB.
    const { req, res, next } = mockReqRes({
      userId: 'user-noloader',
      sessionId: 'sess-1',
      tenantId: 'tenant-1',
      role: 'technician',
    });
    await requireTenant(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req.auth as { mode?: Mode }).mode).toBe('supervisor');
  });

  it('caches the loader result so a second call within the TTL skips the loader', async () => {
    let calls = 0;
    setUserModeLoader(async () => {
      calls += 1;
      return 'both' as Mode;
    });

    const make = () =>
      mockReqRes({
        userId: 'user-cache',
        sessionId: 'sess-1',
        tenantId: 'tenant-1',
        role: 'owner',
      });

    const first = make();
    await requireTenant(first.req, first.res, first.next);
    const second = make();
    await requireTenant(second.req, second.res, second.next);

    expect(calls).toBe(1);
    expect((first.req.auth as { mode?: Mode }).mode).toBe('both');
    expect((second.req.auth as { mode?: Mode }).mode).toBe('both');
  });

  it('returns 401 when req.auth is missing (mode not populated)', async () => {
    const { req, res, next } = mockReqRes(undefined);
    await requireTenant(req, res, next);
    expect((res as any).statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when tenantId is empty (mode not populated)', async () => {
    const { req, res, next } = mockReqRes({
      userId: 'u1',
      sessionId: 's1',
      tenantId: '',
      role: 'owner',
    });
    await requireTenant(req, res, next);
    expect((res as any).statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('does NOT bleed cached mode across tenants for the same Clerk user (regression: review fix)', async () => {
    // The same Clerk subject can be mapped to different users in
    // different tenants. Pre-fix the cache was keyed by userId only,
    // so a tenant-A 'tech' mode would be reused for tenant-B's
    // request to the same Clerk sub for up to 60s.
    const calls: Array<{ userId: string; tenantId: string }> = [];
    setUserModeLoader(async (userId, tenantId) => {
      calls.push({ userId, tenantId });
      return tenantId === 'tenant-A' ? ('tech' as Mode) : ('supervisor' as Mode);
    });

    const sharedUserId = 'user-shared';

    // First request: tenant-A → loader returns 'tech', cached.
    const a = mockReqRes({
      userId: sharedUserId,
      sessionId: 's1',
      tenantId: 'tenant-A',
      role: 'owner',
    });
    await requireTenant(a.req, a.res, a.next);
    expect((a.req.auth as { mode?: Mode }).mode).toBe('tech');

    // Second request: same userId, DIFFERENT tenant. Must NOT serve
    // the cached 'tech' from tenant-A; must call the loader again
    // and resolve to 'supervisor' for tenant-B.
    const b = mockReqRes({
      userId: sharedUserId,
      sessionId: 's2',
      tenantId: 'tenant-B',
      role: 'owner',
    });
    await requireTenant(b.req, b.res, b.next);
    expect((b.req.auth as { mode?: Mode }).mode).toBe('supervisor');

    // Loader called once per (tenant, user) — proves the cache is
    // composite-keyed.
    expect(calls).toEqual([
      { userId: sharedUserId, tenantId: 'tenant-A' },
      { userId: sharedUserId, tenantId: 'tenant-B' },
    ]);

    // Repeat the tenant-A request — should hit cache now (no new loader call).
    const aAgain = mockReqRes({
      userId: sharedUserId,
      sessionId: 's3',
      tenantId: 'tenant-A',
      role: 'owner',
    });
    await requireTenant(aAgain.req, aAgain.res, aAgain.next);
    expect((aAgain.req.auth as { mode?: Mode }).mode).toBe('tech');
    expect(calls).toHaveLength(2); // unchanged: still 2 loader calls total
  });
});
