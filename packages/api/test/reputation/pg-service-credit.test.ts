/**
 * PgServiceCreditRepository smoke test — exercises the query string +
 * row mapping by stubbing pool.connect(). Mirrors the pg-review.test.ts
 * pattern.
 */
import { describe, it, expect, vi } from 'vitest';
import { PgServiceCreditRepository } from '../../src/reputation/pg-service-credit';
import type { Pool } from 'pg';

const TENANT = '22222222-2222-2222-2222-222222222222';
const CUSTOMER = '44444444-4444-4444-4444-444444444444';
const PROPOSAL = '55555555-5555-5555-5555-555555555555';

function makeMockPool(queryFn: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn(async () => ({
      query: queryFn,
      release: vi.fn(),
    })),
  } as unknown as Pool;
}

describe('P7-026 PgServiceCreditRepository', () => {
  it('create issues INSERT INTO service_credits and maps result row', async () => {
    const row = {
      id: '11111111-1111-1111-1111-111111111111',
      tenant_id: TENANT,
      customer_id: CUSTOMER,
      amount_cents: 5000,
      review_id: null,
      proposal_id: PROPOSAL,
      issued_at: '2026-05-17T10:00:00.000Z',
    };
    const queries: string[] = [];
    const queryFn = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('SET app.current_tenant_id')) return { rows: [] };
      return { rows: [row] };
    });
    const repo = new PgServiceCreditRepository(makeMockPool(queryFn));

    const result = await repo.create({
      tenantId: TENANT,
      customerId: CUSTOMER,
      amountCents: 5000,
      reviewId: null,
      proposalId: PROPOSAL,
    });

    expect(result.amountCents).toBe(5000);
    expect(result.tenantId).toBe(TENANT);
    expect(result.customerId).toBe(CUSTOMER);
    expect(result.proposalId).toBe(PROPOSAL);
    expect(result.reviewId).toBeNull();

    // Tenant context MUST be set before the data SQL runs (RLS).
    const setIdx = queries.findIndex((q) => q.includes('set_config')); // U2b-2: SET LOCAL txn
    const insertIdx = queries.findIndex((q) => q.includes('INSERT INTO service_credits'));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(setIdx);
  });

  it('create rejects non-positive amount BEFORE issuing SQL', async () => {
    const queryFn = vi.fn();
    const repo = new PgServiceCreditRepository(makeMockPool(queryFn));
    await expect(
      repo.create({
        tenantId: TENANT,
        customerId: CUSTOMER,
        amountCents: 0,
        reviewId: null,
        proposalId: PROPOSAL,
      }),
    ).rejects.toThrow(/positive/);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('sumIssuedInLast12Months uses 12-month interval window and coerces bigint string', async () => {
    const queries: string[] = [];
    const queryFn = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('SET app.current_tenant_id')) return { rows: [] };
      // Postgres' BIGINT comes back as a string via node-pg by default.
      return { rows: [{ sum_cents: '7500' }] };
    });
    const repo = new PgServiceCreditRepository(makeMockPool(queryFn));

    const sum = await repo.sumIssuedInLast12Months(TENANT, CUSTOMER);
    expect(sum).toBe(7500);
    expect(typeof sum).toBe('number');

    const sumQuery = queries.find((q) => q.includes('FROM service_credits'));
    expect(sumQuery).toBeDefined();
    expect(sumQuery).toContain("INTERVAL '12 months'");
    expect(sumQuery).toContain('COALESCE(SUM(amount_cents), 0)');
  });

  it('sumIssuedInLast12Months returns 0 when no rows match', async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (sql.startsWith('SET app.current_tenant_id')) return { rows: [] };
      return { rows: [{ sum_cents: 0 }] };
    });
    const repo = new PgServiceCreditRepository(makeMockPool(queryFn));
    expect(await repo.sumIssuedInLast12Months(TENANT, CUSTOMER)).toBe(0);
  });

  it('sumIssuedInLast12Months sets tenant context BEFORE running aggregate (RLS)', async () => {
    const queries: string[] = [];
    const queryFn = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('SET app.current_tenant_id')) return { rows: [] };
      return { rows: [{ sum_cents: '0' }] };
    });
    const repo = new PgServiceCreditRepository(makeMockPool(queryFn));
    await repo.sumIssuedInLast12Months(TENANT, CUSTOMER);
    const setIdx = queries.findIndex((q) => q.includes('set_config')); // U2b-2: SET LOCAL txn
    const sumIdx = queries.findIndex((q) => q.includes('FROM service_credits'));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(sumIdx).toBeGreaterThan(setIdx);
  });
});
