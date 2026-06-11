/**
 * Mocked-pool unit tests for PgTenantRepository.
 *
 * Unlike the RLS-scoped repositories, PgTenantRepository queries the global
 * `tenants` table directly via pool.query (no per-call tenant context). These
 * tests verify parameterization, null-on-miss, and row mapping without Docker.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { PgTenantRepository } from '../../src/auth/pg-tenant';

type CapturedCall = { sql: string; params: unknown[] };

function makeMockPool(rows: Record<string, unknown>[]) {
  const calls: CapturedCall[] = [];
  const pool: Partial<Pool> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows, rowCount: rows.length } as unknown as QueryResult;
    }) as unknown as Pool['query'],
  };
  return { pool: pool as Pool, calls };
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const OWNER_ID = 'user_abc';

function tenantRow() {
  return {
    id: TENANT_ID,
    owner_id: OWNER_ID,
    owner_email: 'owner@example.com',
    name: "Owner's Organization",
    created_at: new Date('2026-05-01T00:00:00.000Z'),
  };
}

describe('PgTenantRepository.findByOwner', () => {
  it('returns mapped tenant and parameterizes ownerId', async () => {
    const { pool, calls } = makeMockPool([tenantRow()]);
    const result = await new PgTenantRepository(pool).findByOwner(OWNER_ID);
    expect(result?.id).toBe(TENANT_ID);
    expect(result?.ownerEmail).toBe('owner@example.com');
    expect(calls[0].sql).toContain('WHERE owner_id = $1');
    expect(calls[0].params).toEqual([OWNER_ID]);
  });

  it('returns null when no tenant owned by that user', async () => {
    const { pool } = makeMockPool([]);
    expect(await new PgTenantRepository(pool).findByOwner('nobody')).toBeNull();
  });
});

describe('PgTenantRepository.findById', () => {
  it('returns mapped tenant by id', async () => {
    const { pool, calls } = makeMockPool([tenantRow()]);
    const result = await new PgTenantRepository(pool).findById(TENANT_ID);
    expect(result?.ownerId).toBe(OWNER_ID);
    expect(calls[0].sql).toContain('WHERE id = $1');
    expect(calls[0].params).toEqual([TENANT_ID]);
  });

  it('returns null for unknown id', async () => {
    const { pool } = makeMockPool([]);
    expect(await new PgTenantRepository(pool).findById('missing')).toBeNull();
  });
});

describe('PgTenantRepository.create', () => {
  it('inserts and returns the created tenant with parameterized values', async () => {
    const { pool, calls } = makeMockPool([tenantRow()]);
    const result = await new PgTenantRepository(pool).create({
      ownerId: OWNER_ID,
      ownerEmail: 'owner@example.com',
      name: "Owner's Organization",
    });
    expect(result.id).toBe(TENANT_ID);
    expect(calls[0].sql).toContain('INSERT INTO tenants');
    expect(calls[0].sql).toContain('RETURNING');
    expect(calls[0].params).toEqual([OWNER_ID, 'owner@example.com', "Owner's Organization"]);
  });
});
