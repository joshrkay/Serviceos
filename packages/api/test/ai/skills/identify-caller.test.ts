import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { identifyCaller, normalizePhone } from '../../../src/ai/skills/identify-caller';
import type { IdentifyCallerInput } from '../../../src/ai/skills/identify-caller';
import { isNanpKey } from '../../../src/shared/phone';
import { tenantContextStore } from '../../../src/middleware/tenant-context';
import { fakeTenantPool, type FakeTenantPool } from '../../helpers/fake-tenant-pool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** identifyCaller runs under applyTenantContext, which requires a uuid. */
const TENANT_ID = '00000000-0000-4000-8000-00000000ca11';

function makeRow(id: string, displayName: string): { id: string; display_name: string } {
  return { id, display_name: displayName };
}

/** A pool whose customers lookup answers `rows`; every other statement is empty. */
function makeFake(rows: { id: string; display_name: string }[]): FakeTenantPool {
  return fakeTenantPool((sql) => (sql.includes('FROM customers') ? { rows } : undefined));
}

function makePool(rows: { id: string; display_name: string }[]): Pool {
  return makeFake(rows).pool;
}

function makeInput(overrides: Partial<Omit<IdentifyCallerInput, 'pool'>> & { pool?: Pool }): IdentifyCallerInput {
  return {
    tenantId: TENANT_ID,
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
// isNanpKey — NANP validity of a normalized (leading-1-stripped) key
// ---------------------------------------------------------------------------

describe('isNanpKey', () => {
  it('accepts a valid 10-digit NANP key', () => {
    expect(isNanpKey('5125550111')).toBe(true);
  });

  it('accepts the leading-1-stripped output of a +1 E.164 number', () => {
    expect(isNanpKey(normalizePhone('+15125550111'))).toBe(true);
  });

  it('rejects a non-NANP international number reduced to digits (wrong length)', () => {
    expect(isNanpKey(normalizePhone('+445551112222'))).toBe(false); // "445551112222" (12)
  });

  it('rejects an area code beginning with 0 or 1', () => {
    expect(isNanpKey('1125550111')).toBe(false);
    expect(isNanpKey('0125550111')).toBe(false);
  });

  it('rejects an exchange prefix beginning with 0 or 1', () => {
    expect(isNanpKey('5121550111')).toBe(false);
    expect(isNanpKey('5120550111')).toBe(false);
  });

  it('rejects empty / short / over-long inputs', () => {
    expect(isNanpKey('')).toBe(false);
    expect(isNanpKey('512555011')).toBe(false); // 9 digits
    expect(isNanpKey('51255501110')).toBe(false); // 11 digits
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
    const fake = makeFake([]);
    const result = await identifyCaller(makeInput({ fromPhone: '', pool: fake.pool }));

    expect(result).toEqual({ status: 'unknown' });
    expect(fake.checkouts()).toBe(0);
  });

  it('null-ish phone (whitespace only) → unknown with no query', async () => {
    const fake = makeFake([]);
    const result = await identifyCaller(makeInput({ fromPhone: '   ', pool: fake.pool }));

    expect(result).toEqual({ status: 'unknown' });
    expect(fake.checkouts()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NANP guard — a non-NANP international caller must NOT tail-match a US customer
// (regression proof for the wrong-customer safety finding). `normalizePhone`
// only strips to digits, so `+445551112222` collapses to `445551112222`; taking
// the last 10 digits (`5551112222`) would collide with a US customer stored as
// `5551112222` / `15551112222`. identifyCaller now requires a valid 10-digit
// NANP key before probing, and returns unknown WITHOUT querying otherwise.
// ---------------------------------------------------------------------------

describe('identifyCaller — NANP guard (wrong-customer safety)', () => {
  it('non-NANP international caller → unknown with NO tail probe (even if a US customer would collide)', async () => {
    // Pool would return a US customer if queried — proves we never query.
    const fake = makeFake([makeRow('us-cust', 'Unrelated US')]);

    const result = await identifyCaller(makeInput({ fromPhone: '+445551112222', pool: fake.pool }));

    expect(result).toEqual({ status: 'unknown' });
    expect(fake.checkouts()).toBe(0);
  });

  it('a valid +1 E.164 caller still matches (guard does not break the reconciliation fix)', async () => {
    const pool = makePool([makeRow('cust-e164', 'Ellen E164')]);
    const result = await identifyCaller(makeInput({ fromPhone: '+15125550111', pool }));

    expect(result.status).toBe('matched');
    if (result.status === 'matched') expect(result.customerId).toBe('cust-e164');
  });

  it('a bare 10-digit US caller still matches', async () => {
    const pool = makePool([makeRow('cust-bare', 'Bare Ten')]);
    const result = await identifyCaller(makeInput({ fromPhone: '5125550111', pool }));

    expect(result.status).toBe('matched');
    if (result.status === 'matched') expect(result.customerId).toBe('cust-bare');
  });

  it('a number whose area/exchange starts with 0/1 is not a NANP key → unknown, no query', async () => {
    const fake = makeFake([makeRow('x', 'X')]);

    // Area code 155 is fine, but exchange starting with 1 (1551...) is invalid NANP.
    const result = await identifyCaller(makeInput({ fromPhone: '5551551234', pool: fake.pool }));

    expect(result).toEqual({ status: 'unknown' });
    expect(fake.checkouts()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('identifyCaller — tenant isolation', () => {
  const OTHER_TENANT = '00000000-0000-4000-8000-00000000ca12';

  function lookupOf(fake: FakeTenantPool) {
    const lookups = fake.work();
    expect(lookups).toHaveLength(1);
    return lookups[0];
  }

  it('query always includes tenant_id as first parameter', async () => {
    const fake = makeFake([]);

    await identifyCaller({ tenantId: TENANT_ID, fromPhone: '+15125550100', pool: fake.pool });

    expect(lookupOf(fake).values?.[0]).toBe(TENANT_ID);
  });

  it('query uses phone_normalized column', async () => {
    const fake = makeFake([]);

    await identifyCaller({ tenantId: TENANT_ID, fromPhone: '+15125550100', pool: fake.pool });

    expect(lookupOf(fake).sql).toContain('phone_normalized');
  });

  it('uses the index-friendly IN(...) form, not right()/LIKE (perf: no full tenant scan)', async () => {
    const fake = makeFake([]);

    await identifyCaller({ tenantId: TENANT_ID, fromPhone: '+15125550100', pool: fake.pool });

    const { sql, values } = lookupOf(fake);
    expect(sql).toContain("phone_normalized IN ($2, '1' || $2)");
    expect(sql).not.toMatch(/right\s*\(/i);
    expect(sql).not.toMatch(/LIKE/i);
    // $2 is the 10-digit bare tail (no leading 1).
    expect(values?.[1]).toBe('5125550100');
  });

  it('different tenants are isolated — query scoped to provided tenantId', async () => {
    const fake = makeFake([]);

    await identifyCaller({ tenantId: OTHER_TENANT, fromPhone: '+15125550100', pool: fake.pool });

    expect(lookupOf(fake).values?.[0]).toBe(OTHER_TENANT);
  });

  it('runs the lookup in a tenant transaction on one checkout: BEGIN, the tenant GUC, SELECT, COMMIT', async () => {
    const fake = makeFake([makeRow('cust-1', 'Alice Smith')]);

    await identifyCaller({ tenantId: TENANT_ID, fromPhone: '+15125550100', pool: fake.pool });

    expect(fake.checkouts()).toBe(1);
    expect(fake.open()).toBe(0);
    expect(fake.statements.map((s) => s.sql.trim().split(/\s+/)[0])).toEqual(['BEGIN', 'SELECT', 'SELECT', 'COMMIT']);
    expect(fake.statements[1]).toMatchObject({
      sql: expect.stringContaining("set_config('app.current_tenant_id'"),
      values: [TENANT_ID],
    });
  });

  it("inside a request scoped to the same tenant, runs on the request's client and takes no checkout", async () => {
    const fake = makeFake([]);
    const requestQuery = vi.fn(async () => ({ rows: [makeRow('cust-req', 'Req Client')] }));
    const client = { query: requestQuery } as unknown as PoolClient;

    const result = await tenantContextStore.run({ client, tenantId: TENANT_ID }, () =>
      identifyCaller({ tenantId: TENANT_ID, fromPhone: '+15125550100', pool: fake.pool }),
    );

    expect(result).toMatchObject({ status: 'matched', customerId: 'cust-req' });
    expect(fake.checkouts()).toBe(0);
    expect(requestQuery).toHaveBeenCalledOnce();
  });
});
