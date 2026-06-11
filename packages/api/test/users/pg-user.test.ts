import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryUserRepository, User } from '../../src/users/user';
import { normalizeMobileE164 } from '../../src/shared/phone/normalize';
import { MIGRATIONS } from '../../src/db/schema';

/**
 * P1-022 — mobile_number identity binding.
 *
 * The Pg implementation requires a live Postgres (partial unique index,
 * RLS) and is exercised by the gated integration suite. These unit tests
 * cover the tenant-scoped lookup contract via the in-memory repository
 * (which satisfies the same `UserRepository` interface), the migration DDL
 * shape, and the raw-input → store → lookup round trip through the
 * normalizer.
 */

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function seed(repo: InMemoryUserRepository, overrides: Partial<User> = {}): Promise<User> {
  return repo.create!({
    id: uuidv4(),
    tenantId: TENANT_A,
    clerkUserId: `user_${Math.random()}`,
    email: `${Math.random()}@example.com`,
    role: 'technician',
    canFieldServe: false,
    ...overrides,
  });
}

describe('P1-022 findByMobileNumber (tenant-scoped lookup contract)', () => {
  let repo: InMemoryUserRepository;
  beforeEach(() => {
    repo = new InMemoryUserRepository();
  });

  it('adds a mobile to a user and looks it up by E.164', async () => {
    const e164 = normalizeMobileE164('(555) 123-4567');
    const u = await seed(repo, { mobileNumber: e164 });
    const found = await repo.findByMobileNumber(TENANT_A, e164);
    expect(found?.id).toBe(u.id);
    expect(found?.mobileNumber).toBe('+15551234567');
  });

  it('findByMobileNumber returns null for cross-tenant lookups', async () => {
    const e164 = normalizeMobileE164('5551234567');
    await seed(repo, { tenantId: TENANT_A, mobileNumber: e164 });
    // Same number, different tenant — must not leak the tenant-A row.
    const leaked = await repo.findByMobileNumber(TENANT_B, e164);
    expect(leaked).toBeNull();
  });

  it('two users in different tenants CAN share a mobile (lookup resolves per tenant)', async () => {
    const e164 = normalizeMobileE164('555-123-4567');
    const a = await seed(repo, { tenantId: TENANT_A, mobileNumber: e164 });
    const b = await seed(repo, { tenantId: TENANT_B, mobileNumber: e164 });
    expect((await repo.findByMobileNumber(TENANT_A, e164))?.id).toBe(a.id);
    expect((await repo.findByMobileNumber(TENANT_B, e164))?.id).toBe(b.id);
  });

  it('multiple users with NULL mobile coexist in the same tenant', async () => {
    await seed(repo, { tenantId: TENANT_A });
    await seed(repo, { tenantId: TENANT_A });
    const all = await repo.findByTenant(TENANT_A);
    expect(all).toHaveLength(2);
    expect(all.every((u) => u.mobileNumber === undefined)).toBe(true);
  });

  it('returns null when no user in the tenant has that mobile', async () => {
    await seed(repo, { mobileNumber: '+15550009999' });
    const found = await repo.findByMobileNumber(TENANT_A, '+15551234567');
    expect(found).toBeNull();
  });
});

describe('P1-022 migration 109_users_mobile_number DDL', () => {
  const sql = MIGRATIONS['109_users_mobile_number'];

  it('is registered in MIGRATIONS', () => {
    expect(sql).toBeDefined();
  });

  it('adds the column idempotently (IF NOT EXISTS)', () => {
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number TEXT/);
  });

  it('creates a tenant-scoped partial unique index that permits NULLs', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS users_mobile_unique/);
    expect(sql).toMatch(/ON users \(tenant_id, mobile_number\)/);
    expect(sql).toMatch(/WHERE mobile_number IS NOT NULL/);
  });
});
