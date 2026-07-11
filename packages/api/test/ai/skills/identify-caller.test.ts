import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { identifyCaller, normalizePhone } from '../../../src/ai/skills/identify-caller';
import type { IdentifyCallerInput } from '../../../src/ai/skills/identify-caller';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(id: string, displayName: string): { id: string; display_name: string } {
  return { id, display_name: displayName };
}

function makePool(rows: { id: string; display_name: string }[]): Pool {
  const query = vi.fn().mockResolvedValue({ rows } as unknown as QueryResult);
  return { query } as unknown as Pool;
}

function makeInput(overrides: Partial<Omit<IdentifyCallerInput, 'pool'>> & { pool?: Pool }): IdentifyCallerInput {
  return {
    tenantId: 'tenant-abc',
    fromPhone: '+15125550100',
    pool: makePool([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizePhone unit tests
// ---------------------------------------------------------------------------

describe('normalizePhone', () => {
  it('strips non-digit characters from E.164 number', () => {
    expect(normalizePhone('+15125550100')).toBe('5125550100');
  });

  it('leaves local 10-digit number unchanged', () => {
    expect(normalizePhone('5125550100')).toBe('5125550100');
  });

  it('strips dashes and parens from formatted number', () => {
    expect(normalizePhone('(512) 555-0100')).toBe('5125550100');
  });

  it('strips leading 1 from 11-digit number', () => {
    expect(normalizePhone('15125550100')).toBe('5125550100');
  });

  it('does not strip leading 1 from a 10-digit number starting with 1', () => {
    expect(normalizePhone('1234567890')).toBe('1234567890');
  });

  it('returns empty string for empty input', () => {
    expect(normalizePhone('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// phone_normalized reconciliation invariant (locks the 5f97649 lookup fix)
// ---------------------------------------------------------------------------
//
// The generated column `customers.phone_normalized` (migration
// 053_p8_customers_phone_index) is `regexp_replace(primary_phone, '[^0-9]',
// '', 'g')` — it strips punctuation but KEEPS the leading country-code 1, so a
// customer saved as "+15125550111" stores "15125550111". `normalizePhone`
// above instead DROPS the leading 1, producing the 10-digit bare key. A plain
// `phone_normalized = normalizePhone(from)` equality therefore misses every +1
// E.164 customer. identifyCaller reconciles the two conventions by matching on
// the trailing-10 digits from both sides. This unit test documents that
// divergence + reconciliation so a future refactor of either side can't
// silently re-break inbound caller-ID. The end-to-end proof against the real
// generated column lives in test/integration/identify-caller.test.ts.
describe('phone_normalized reconciliation invariant', () => {
  // What the generated column stores for a customer saved in +1 E.164 form.
  const storedGeneratedForm = '15125550111'; // regexp_replace keeps the leading 1

  it('normalizePhone strips the leading 1 that the generated column keeps', () => {
    const appKey = normalizePhone('+15125550111');
    expect(appKey).toBe('5125550111'); // 10-digit bare key, no leading 1
    expect(storedGeneratedForm).toBe('1' + appKey); // the column keeps the 1
    expect(appKey).not.toBe(storedGeneratedForm); // → plain equality would miss
  });

  it("the 10-digit tail + a leading-1 variant reconcile with the stored +1 form", () => {
    const appKey = normalizePhone('+15125550111');
    // identifyCaller now probes `phone_normalized IN ($tail, '1' || $tail)`
    // (index-friendly equality) instead of `right()`/`LIKE`. The stored +1 form
    // equals the leading-1 variant of the 10-digit tail.
    expect('1' + appKey.slice(-10)).toBe(storedGeneratedForm);
  });

  it('bare 10-digit stored form also reconciles via the trailing-10 match', () => {
    const appKey = normalizePhone('+15125550222');
    const storedBareForm = '5125550222'; // customer saved as "5125550222"
    expect(storedBareForm.slice(-10)).toBe(appKey.slice(-10));
  });
});

// ---------------------------------------------------------------------------
// identifyCaller — matched
// ---------------------------------------------------------------------------

describe('identifyCaller — matched', () => {
  it('E.164 number matches a single customer', async () => {
    const pool = makePool([makeRow('cust-1', 'Alice Smith')]);
    const result = await identifyCaller(makeInput({ fromPhone: '+15125550100', pool }));

    expect(result).toEqual({
      status: 'matched',
      customerId: 'cust-1',
      customerName: 'Alice Smith',
      displayName: 'Alice Smith',
    });
  });

  it('local 10-digit format matches the same record as E.164', async () => {
    const pool = makePool([makeRow('cust-1', 'Alice Smith')]);
    const result = await identifyCaller(makeInput({ fromPhone: '5125550100', pool }));

    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.customerId).toBe('cust-1');
    }
  });

  it('+1 prefix stripped — 11-digit number resolves to same customer as 10-digit', async () => {
    const pool = makePool([makeRow('cust-2', 'Bob Jones')]);
    const result = await identifyCaller(makeInput({ fromPhone: '+15125550200', pool }));

    expect(result.status).toBe('matched');
    if (result.status === 'matched') {
      expect(result.customerId).toBe('cust-2');
    }
  });
});

// ---------------------------------------------------------------------------
// identifyCaller — multiple
// ---------------------------------------------------------------------------

describe('identifyCaller — multiple', () => {
  it('two customers with the same normalized phone → multiple', async () => {
    const pool = makePool([
      makeRow('cust-3', 'Carol White'),
      makeRow('cust-4', 'Dave Black'),
    ]);
    const result = await identifyCaller(makeInput({ fromPhone: '+15125550300', pool }));

    expect(result).toEqual({
      status: 'multiple',
      candidates: [
        { customerId: 'cust-3', customerName: 'Carol White' },
        { customerId: 'cust-4', customerName: 'Dave Black' },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// identifyCaller — unknown
// ---------------------------------------------------------------------------

describe('identifyCaller — unknown', () => {
  it('no matching customer → unknown', async () => {
    const pool = makePool([]);
    const result = await identifyCaller(makeInput({ fromPhone: '+15125559999', pool }));

    expect(result).toEqual({ status: 'unknown' });
  });

  it('empty phone string → unknown with no query', async () => {
    const queryFn = vi.fn();
    const pool = { query: queryFn } as unknown as Pool;
    const result = await identifyCaller(makeInput({ fromPhone: '', pool }));

    expect(result).toEqual({ status: 'unknown' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('null-ish phone (whitespace only) → unknown with no query', async () => {
    const queryFn = vi.fn();
    const pool = { query: queryFn } as unknown as Pool;
    const result = await identifyCaller(makeInput({ fromPhone: '   ', pool }));

    expect(result).toEqual({ status: 'unknown' });
    expect(queryFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('identifyCaller — tenant isolation', () => {
  it('query always includes tenant_id as first parameter', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] } as unknown as QueryResult);
    const pool = { query: queryFn } as unknown as Pool;

    await identifyCaller({ tenantId: 'tenant-xyz', fromPhone: '+15125550100', pool });

    expect(queryFn).toHaveBeenCalledOnce();
    const [_sql, params] = queryFn.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('tenant-xyz');
  });

  it('query uses phone_normalized column', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] } as unknown as QueryResult);
    const pool = { query: queryFn } as unknown as Pool;

    await identifyCaller({ tenantId: 'tenant-xyz', fromPhone: '+15125550100', pool });

    const [sql] = queryFn.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('phone_normalized');
  });

  it('uses the index-friendly IN(...) form, not right()/LIKE (perf: no full tenant scan)', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] } as unknown as QueryResult);
    const pool = { query: queryFn } as unknown as Pool;

    await identifyCaller({ tenantId: 'tenant-xyz', fromPhone: '+15125550100', pool });

    const [sql, params] = queryFn.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("phone_normalized IN ($2, '1' || $2)");
    expect(sql).not.toMatch(/right\s*\(/i);
    expect(sql).not.toMatch(/LIKE/i);
    // $2 is the 10-digit bare tail (no leading 1).
    expect(params[1]).toBe('5125550100');
  });

  it('different tenants are isolated — query scoped to provided tenantId', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: [] } as unknown as QueryResult);
    const pool = { query: queryFn } as unknown as Pool;

    await identifyCaller({ tenantId: 'tenant-A', fromPhone: '+15125550100', pool });

    const [_sql, params] = queryFn.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('tenant-A');
    expect(params[0]).not.toBe('tenant-B');
  });
});
