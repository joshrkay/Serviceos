import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { InMemoryUserRepository, User } from '../../src/users/user';
import { PgUserRepository } from '../../src/users/pg-user';
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

/**
 * #866 follow-up (code-quality review of the phone-actor commit) —
 * PgUserRepository.mapRow never mapped `status`/`deleted_at`, so
 * resolvePhoneActor's `isActive()` check was a no-op against real
 * Postgres: a suspended technician with a mobile on file would still
 * resolve as an actor, and a suspended ex-owner would be miscounted
 * against the sole-active-owner bridge. Pin the mapping with a mocked
 * Pool (the `withTenant`/`withTenantTransaction` framework queries —
 * BEGIN/COMMIT/SET LOCAL ROLE/SELECT set_config — pass through; the
 * one non-framework query is the real SELECT under test), mirroring
 * the pattern in test/appointments/pg-appointment.test.ts.
 */
describe('PgUserRepository — status + deleted_at mapping (#866 follow-up)', () => {
  const TENANT_ID = '550e8400-e29b-41d4-a716-446655440000';

  function buildRowPool(row: Record<string, unknown>) {
    const queries: string[] = [];
    const client: Partial<PoolClient> = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b|SELECT set_config)/i.test(sql)) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        return { rows: [row], rowCount: 1 } as unknown as QueryResult;
      }) as unknown as PoolClient['query'],
      release: vi.fn() as unknown as PoolClient['release'],
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
    };
    return { pool: pool as Pool, queries };
  }

  const suspendedDeletedRow = {
    id: 'u-1',
    tenant_id: TENANT_ID,
    clerk_user_id: null,
    email: 'suspended@example.com',
    role: 'technician',
    first_name: null,
    last_name: null,
    can_field_serve: false,
    mobile_number: '+15125550111',
    status: 'suspended',
    deleted_at: '2026-08-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  it('findByMobileNumber maps status and deleted_at from the row (not a no-op)', async () => {
    const { pool } = buildRowPool(suspendedDeletedRow);
    const repo = new PgUserRepository(pool);

    const user = await repo.findByMobileNumber(TENANT_ID, '+15125550111');

    expect(user?.status).toBe('suspended');
    expect(user?.deletedAt).toBeInstanceOf(Date);
  });

  it('findByMobileNumber SELECTs status and deleted_at as columns (not just in the WHERE clause)', async () => {
    const { pool, queries } = buildRowPool(suspendedDeletedRow);
    const repo = new PgUserRepository(pool);

    await repo.findByMobileNumber(TENANT_ID, '+15125550111');

    const selectSql = queries.find((q) => /SELECT id,\s*tenant_id/i.test(q));
    expect(selectSql).toBeDefined();
    const fromIdx = selectSql!.search(/\bFROM\b/i);
    const selectClause = selectSql!.slice(0, fromIdx);
    expect(selectClause).toMatch(/\bstatus\b/);
    expect(selectClause).toMatch(/\bdeleted_at\b/);
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
