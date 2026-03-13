/**
 * P0-002 — Clerk auth and tenant bootstrap
 *
 * The old decodeClerkToken() function manually base64-decoded JWTs without
 * verifying the RS256 signature (a critical security bug). It has been
 * replaced by @clerk/express clerkMiddleware() + extractAuthContext(), which
 * uses Clerk's SDK to verify tokens against the JWKS endpoint.
 *
 * These tests cover extractAuthContext() using a mock of getAuth(), and the
 * bootstrapTenant() function which remains unchanged.
 */

import {
  extractAuthContext,
  bootstrapTenant,
  TenantRepository,
  Tenant,
  AuthenticatedRequest,
} from '../../src/auth/clerk';
import { Response, NextFunction } from 'express';

// ── Mock @clerk/express so tests run without a real Clerk secret key ──────────

jest.mock('@clerk/express', () => ({
  clerkMiddleware: () =>
    (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAuth } = require('@clerk/express') as {
  getAuth: jest.MockedFunction<(req: unknown) => unknown>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContext() {
  const req = {} as AuthenticatedRequest;
  const res = {} as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

// ── extractAuthContext ─────────────────────────────────────────────────────────

describe('P0-002 — Clerk auth and tenant bootstrap', () => {
  describe('extractAuthContext', () => {
    beforeEach(() => {
      getAuth.mockReset();
    });

    it('happy path — attaches auth context from verified JWT claims', () => {
      getAuth.mockReturnValue({
        userId: 'user_123',
        sessionId: 'sess_abc',
        sessionClaims: { tenant_id: 'tenant_456', role: 'owner' },
      });

      const { req, res, next } = makeContext();
      extractAuthContext(req, res, next);

      expect(req.auth).toEqual({
        userId: 'user_123',
        sessionId: 'sess_abc',
        tenantId: 'tenant_456',
        role: 'owner',
      });
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('unauthenticated — passes through without setting req.auth', () => {
      getAuth.mockReturnValue({ userId: null });

      const { req, res, next } = makeContext();
      extractAuthContext(req, res, next);

      expect(req.auth).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('tenant isolation — tenant_id claim is mapped to tenantId', () => {
      getAuth.mockReturnValue({
        userId: 'user_123',
        sessionId: 'sess_abc',
        sessionClaims: { tenant_id: 'tenant_999', role: 'dispatcher' },
      });

      const { req, res, next } = makeContext();
      extractAuthContext(req, res, next);

      expect(req.auth?.tenantId).toBe('tenant_999');
    });

    it('defaults role to technician when claim is absent', () => {
      getAuth.mockReturnValue({
        userId: 'user_123',
        sessionId: 'sess_abc',
        sessionClaims: { tenant_id: 'tenant_456' },
      });

      const { req, res, next } = makeContext();
      extractAuthContext(req, res, next);

      expect(req.auth?.role).toBe('technician');
    });

    it('defaults tenantId to empty string when claim is absent', () => {
      getAuth.mockReturnValue({
        userId: 'user_123',
        sessionId: 'sess_abc',
        sessionClaims: { role: 'owner' },
      });

      const { req, res, next } = makeContext();
      extractAuthContext(req, res, next);

      expect(req.auth?.tenantId).toBe('');
    });

    it('no sessionClaims — still attaches userId with safe defaults', () => {
      getAuth.mockReturnValue({
        userId: 'user_123',
        sessionId: 'sess_abc',
        sessionClaims: null,
      });

      const { req, res, next } = makeContext();
      extractAuthContext(req, res, next);

      expect(req.auth?.userId).toBe('user_123');
      expect(req.auth?.tenantId).toBe('');
      expect(req.auth?.role).toBe('technician');
    });

    it('null auth — next() is still called, req.auth remains unset', () => {
      getAuth.mockReturnValue(null);

      const { req, res, next } = makeContext();
      extractAuthContext(req, res, next);

      expect(req.auth).toBeUndefined();
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  // ── bootstrapTenant ─────────────────────────────────────────────────────────

  describe('bootstrapTenant', () => {
    let mockRepo: TenantRepository;
    let tenants: Map<string, Tenant>;

    beforeEach(() => {
      tenants = new Map();
      mockRepo = {
        findByOwner: async (ownerId: string) => {
          for (const t of tenants.values()) {
            if (t.ownerId === ownerId) return t;
          }
          return null;
        },
        findById: async (id: string) => tenants.get(id) ?? null,
        create: async (data) => {
          const tenant: Tenant = {
            id: 'tenant_' + Math.random().toString(36).substring(7),
            ownerId: data.ownerId,
            ownerEmail: data.ownerEmail,
            name: data.name,
            createdAt: new Date(),
          };
          tenants.set(tenant.id, tenant);
          return tenant;
        },
      };
    });

    it('happy path — creates new tenant on first signup', async () => {
      const result = await bootstrapTenant('user_1', 'test@example.com', mockRepo);
      expect(result.created).toBe(true);
      expect(result.ownerId).toBe('user_1');
      expect(result.tenantId).toBeTruthy();
    });

    it('idempotent — returns existing tenant on duplicate signup', async () => {
      const first = await bootstrapTenant('user_1', 'test@example.com', mockRepo);
      const second = await bootstrapTenant('user_1', 'test@example.com', mockRepo);
      expect(second.created).toBe(false);
      expect(second.tenantId).toBe(first.tenantId);
    });

    it('validation — rejects empty userId', async () => {
      await expect(
        bootstrapTenant('', 'test@example.com', mockRepo)
      ).rejects.toThrow('userId and email are required');
    });

    it('validation — rejects empty email', async () => {
      await expect(
        bootstrapTenant('user_1', '', mockRepo)
      ).rejects.toThrow('userId and email are required');
    });

    it('tenant isolation — separate tenants created for different owners', async () => {
      const t1 = await bootstrapTenant('user_1', 'a@example.com', mockRepo);
      const t2 = await bootstrapTenant('user_2', 'b@example.com', mockRepo);
      expect(t1.tenantId).not.toBe(t2.tenantId);
    });
  });
});
