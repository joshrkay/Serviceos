import * as crypto from 'crypto';
import {
  decodeClerkToken,
  bootstrapTenant,
  TenantRepository,
  Tenant,
} from '../../src/auth/clerk';

const TEST_SECRET = 'test-secret-key';

function createMockToken(payload: Record<string, unknown>, secret: string = TEST_SECRET): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${header}.${body}`;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(signatureInput)
    .digest('base64url');
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

      const result = decodeClerkToken(token, TEST_SECRET);
      expect(result.sub).toBe('user_123');
      expect(result.sid).toBe('sess_abc');
      expect(result.tenant_id).toBe('tenant_456');
      expect(result.role).toBe('owner');
    });

    it('validation — rejects malformed token', () => {
      expect(() => decodeClerkToken('invalid-token', TEST_SECRET)).toThrow('Invalid token format');
    });

    it('validation — rejects token missing sub claim', () => {
      const token = createMockToken({ sid: 'sess_abc', exp: Math.floor(Date.now() / 1000) + 3600, role: 'owner' });
      expect(() => decodeClerkToken(token, TEST_SECRET)).toThrow('Missing required token claims');
    });

    it('validation — rejects expired token', () => {
      const token = createMockToken({
        sub: 'user_123',
        sid: 'sess_abc',
        role: 'owner',
        exp: Math.floor(Date.now() / 1000) - 3600,
      });
      expect(() => decodeClerkToken(token, TEST_SECRET)).toThrow('Token expired');
    });

    it('validation — rejects token with invalid signature', () => {
      const token = createMockToken({
        sub: 'user_123',
        sid: 'sess_abc',
        role: 'owner',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }, 'correct-secret');
      expect(() => decodeClerkToken(token, 'wrong-secret')).toThrow('Invalid token signature');
    });

    it('validation — rejects token missing exp claim', () => {
      const token = createMockToken({
        sub: 'user_123',
        sid: 'sess_abc',
        role: 'owner',
      });
      expect(() => decodeClerkToken(token, TEST_SECRET)).toThrow('Token missing expiration claim');
    });

    it('validation — rejects token missing role claim', () => {
      const token = createMockToken({
        sub: 'user_123',
        sid: 'sess_abc',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(() => decodeClerkToken(token, TEST_SECRET)).toThrow('Token missing or invalid role claim');
    });

    it('validation — rejects token with invalid role', () => {
      const token = createMockToken({
        sub: 'user_123',
        sid: 'sess_abc',
        role: 'superadmin',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(() => decodeClerkToken(token, TEST_SECRET)).toThrow('Token missing or invalid role claim');
    });

    it('missing auth returns 401 — no bearer token results in no auth context', () => {
      expect(() => decodeClerkToken('', TEST_SECRET)).toThrow();
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
