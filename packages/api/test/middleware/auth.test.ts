import { Request, Response } from 'express';
import {
  requireAuth,
  requireTenant,
  requirePermission,
  requireRole,
  enforceTenantIsolation,
  resolveAuthorization,
  setAuthorizationLoader,
  type AuthorizationLoader,
  type MembershipRecord,
} from '../../src/middleware/auth';
import { AuthenticatedRequest } from '../../src/auth/clerk';

function mockReqRes(auth?: AuthenticatedRequest['auth'], params?: Record<string, string>) {
  const req = { auth, params: params || {}, body: {}, path: '/api/x' } as unknown as AuthenticatedRequest;
  const resObj: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      resObj.statusCode = code;
      return resObj;
    },
    json(data: unknown) {
      resObj.body = data;
      return resObj;
    },
  };
  const next = vi.fn();
  return { req, res: resObj as Response, next };
}

describe('P0-003 — Auth middleware', () => {
  describe('requireAuth', () => {
    it('missing auth returns 401', () => {
      const { req, res, next } = mockReqRes();
      requireAuth(req, res, next);
      expect((res as any).statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('happy path — passes with auth', () => {
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: 't1',
        role: 'owner',
      });
      requireAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('requireTenant', () => {
    it('missing auth returns 401', () => {
      const { req, res, next } = mockReqRes();
      requireTenant(req, res, next);
      expect((res as any).statusCode).toBe(401);
    });

    it('missing tenantId returns 403', () => {
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: '',
        role: 'owner',
      });
      requireTenant(req, res, next);
      expect((res as any).statusCode).toBe(403);
    });
  });

  describe('requirePermission', () => {
    it('role escalation test — technician denied tenant:manage', () => {
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: 't1',
        role: 'technician',
      });
      requirePermission('tenant:manage')(req, res, next);
      expect((res as any).statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('happy path — owner allowed tenant:manage', () => {
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: 't1',
        role: 'owner',
      });
      requirePermission('tenant:manage')(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // QUALITY-2026-07-12 WS4 — DB-authoritative authorization.
  // ───────────────────────────────────────────────────────────────────────
  describe('resolveAuthorization', () => {
    afterEach(() => {
      // Never leak a loader into another test — the module-level ref is shared.
      setAuthorizationLoader(null);
    });

    const active = (role: string): MembershipRecord => ({
      role,
      deleted: false,
      status: 'active',
    });

    it('stale JWT role claim — token says owner, DB says technician → technician enforced', async () => {
      setAuthorizationLoader(async () => active('technician'));
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: 't1',
        role: 'owner', // stale/forged claim
      });
      await resolveAuthorization(req, res, next);
      expect(next).toHaveBeenCalled();
      // The DB role overwrites the token claim.
      expect(req.auth!.role).toBe('technician');
      // And the downstream permission gate now denies owner-only actions.
      requirePermission('tenant:manage')(req, res, next);
      expect((res as any).statusCode).toBe(403);
    });

    it('deleted user (valid token) → 403 and no next()', async () => {
      setAuthorizationLoader(async () => ({ role: 'owner', deleted: true, status: 'active' }));
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: 't1',
        role: 'owner',
      });
      await resolveAuthorization(req, res, next);
      expect((res as any).statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('suspended user (valid token) → 403 and no next()', async () => {
      setAuthorizationLoader(async () => ({ role: 'dispatcher', deleted: false, status: 'suspended' }));
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: 't1',
        role: 'dispatcher',
      });
      await resolveAuthorization(req, res, next);
      expect((res as any).statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('user with no membership row → 403 and no next()', async () => {
      setAuthorizationLoader(async () => null);
      const { req, res, next } = mockReqRes({
        userId: 'ghost',
        sessionId: 's1',
        tenantId: 't1',
        role: 'owner',
      });
      await resolveAuthorization(req, res, next);
      expect((res as any).statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('DB error → fails CLOSED with 503, does not default to a role', async () => {
      const loader: AuthorizationLoader = async () => {
        throw new Error('connection terminated');
      };
      setAuthorizationLoader(loader);
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: 't1',
        role: 'owner',
      });
      await resolveAuthorization(req, res, next);
      expect((res as any).statusCode).toBe(503);
      expect(next).not.toHaveBeenCalled();
    });

    it('active member — DB role applied and request proceeds', async () => {
      setAuthorizationLoader(async () => active('dispatcher'));
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: 't1',
        role: 'dispatcher',
      });
      await resolveAuthorization(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.auth!.role).toBe('dispatcher');
    });

    it('no loader wired (dev / no-DB) — keeps the JWT claim and proceeds', async () => {
      setAuthorizationLoader(null);
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: 't1',
        role: 'owner',
      });
      await resolveAuthorization(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.auth!.role).toBe('owner');
    });

    it('authenticated but tenantless — skips DB resolution, keeps claim', async () => {
      let called = false;
      setAuthorizationLoader(async () => {
        called = true;
        return null;
      });
      const { req, res, next } = mockReqRes({
        userId: 'u1',
        sessionId: 's1',
        tenantId: '',
        role: 'owner',
      });
      await resolveAuthorization(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(called).toBe(false);
      expect(req.auth!.role).toBe('owner');
    });
  });

  describe('enforceTenantIsolation', () => {
    it('wrong tenant returns 403', () => {
      const { req, res, next } = mockReqRes(
        { userId: 'u1', sessionId: 's1', tenantId: 't1', role: 'owner' },
        { tenantId: 't2' }
      );
      enforceTenantIsolation()(req, res, next);
      expect((res as any).statusCode).toBe(403);
    });

    it('happy path — same tenant passes', () => {
      const { req, res, next } = mockReqRes(
        { userId: 'u1', sessionId: 's1', tenantId: 't1', role: 'owner' },
        { tenantId: 't1' }
      );
      enforceTenantIsolation()(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
