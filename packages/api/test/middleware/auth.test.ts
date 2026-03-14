import { Request, Response } from 'express';
import {
  requireAuth,
  requireTenant,
  requirePermission,
  requireRole,
  enforceTenantIsolation,
} from '../../src/middleware/auth';
import { AuthenticatedRequest } from '../../src/auth/clerk';

function mockReqRes(auth?: AuthenticatedRequest['auth'], params?: Record<string, string>) {
  const req = { auth, params: params || {}, body: {} } as unknown as AuthenticatedRequest;
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
