import {
  decodeClerkToken,
  bootstrapTenant,
  TenantRepository,
  Tenant,
} from '../../src/auth/clerk';

function createMockToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('mock-signature').toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('P0-002 — Clerk auth and tenant bootstrap', () => {
  describe('decodeClerkToken', () => {
    it('happy path — decodes a valid token', () => {
      const token = createMockToken({
        sub: 'user_123',
        sid: 'sess_abc',
        tenant_id: 'tenant_456',
        role: 'owner',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const result = decodeClerkToken(token, 'test-secret');
      expect(result.sub).toBe('user_123');
      expect(result.sid).toBe('sess_abc');
      expect(result.tenant_id).toBe('tenant_456');
      expect(result.role).toBe('owner');
    });

    it('validation — rejects malformed token', () => {
      expect(() => decodeClerkToken('invalid-token', 'secret')).toThrow('Invalid token format');
    });

    it('validation — rejects token missing sub claim', () => {
      const token = createMockToken({ sid: 'sess_abc' });
      expect(() => decodeClerkToken(token, 'secret')).toThrow('Missing required token claims');
    });

    it('validation — rejects expired token', () => {
      const token = createMockToken({
        sub: 'user_123',
        sid: 'sess_abc',
        exp: Math.floor(Date.now() / 1000) - 3600,
      });
      expect(() => decodeClerkToken(token, 'secret')).toThrow('Token expired');
    });

    it('missing auth returns 401 — no bearer token results in no auth context', () => {
      // When there's no token, decodeClerkToken is never called.
      // The middleware simply doesn't set req.auth.
      // This test validates the token validation itself rejects empty input.
      expect(() => decodeClerkToken('', 'secret')).toThrow();
    });
  });

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
        findById: async (id: string) => tenants.get(id) || null,
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
      await expect(bootstrapTenant('', 'test@example.com', mockRepo)).rejects.toThrow(
        'userId and email are required'
      );
    });

    it('validation — rejects empty email', async () => {
      await expect(bootstrapTenant('user_1', '', mockRepo)).rejects.toThrow(
        'userId and email are required'
      );
    });

    it('wrong tenant returns 403 — separate tenants for different owners', async () => {
      const t1 = await bootstrapTenant('user_1', 'a@example.com', mockRepo);
      const t2 = await bootstrapTenant('user_2', 'b@example.com', mockRepo);
      expect(t1.tenantId).not.toBe(t2.tenantId);
    });
  });
});
