/**
 * P8-001 — PgEntityResolver tests.
 *
 * Uses a mocked Pool (no real DB). Tests verify:
 *   - Exact name match → resolved with confidence 1.0
 *   - Fuzzy match ("Rodrigez" → "Rodriguez") → resolved with confidence < 1
 *   - Two candidates above τ_ent (0.80) → ambiguous with both in result
 *   - No candidate above τ_ent → not_found
 *   - Tenant isolation — query always includes tenant_id = $1
 *   - Empty/null input → skipped
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgEntityResolver } from '../../../src/ai/resolution/pg-entity-resolver';

// ---------------------------------------------------------------------------
// Mock pool helpers
// ---------------------------------------------------------------------------

type CapturedCall = { sql: string; params: unknown[] };

interface MockRow {
  id?: string;
  display_name?: string;
  primary_phone?: string | null;
  summary?: string;
  status?: string | null;
  invoice_number?: string;
  doc_number?: string;
  scheduled_start?: string;
  score?: number;
}

function makeMockPool(rowsBySlot: Array<MockRow[] | undefined>) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;
  let businessQueryIndex = 0;

  // Each resolve() runs in a transaction: BEGIN → set_config(tenant) →
  // business SELECT(s) → COMMIT (ROLLBACK on error). Slot 0 is the canned result
  // for the RLS-context statements (always empty); slots 1+ hold business rows
  // returned in order (exact-match query, then trigram fallback, etc.).
  const isContextStatement = (sql: string) =>
    /^\s*(BEGIN|COMMIT|ROLLBACK|SET\b)/i.test(sql) || /set_config/i.test(sql);

  const businessSlots = rowsBySlot.slice(1);

  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      let rows: MockRow[];
      if (isContextStatement(sql)) {
        rows = rowsBySlot[0] ?? [];
      } else {
        const slot = businessSlots[businessQueryIndex] ?? businessSlots[businessSlots.length - 1];
        businessQueryIndex += 1;
        rows = slot ?? [];
      }
      return {
        rows,
        rowCount: rows.length,
        command: '',
        oid: 0,
        fields: [],
      } as unknown as QueryResult;
    }) as unknown as PoolClient['query'],
    release: vi.fn(() => {
      releaseCount += 1;
    }) as unknown as PoolClient['release'],
  };

  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
  };

  return {
    pool: pool as Pool,
    client,
    calls,
    getReleaseCount: () => releaseCount,
  };
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

// ---------------------------------------------------------------------------
// Customer resolution
// ---------------------------------------------------------------------------

describe('PgEntityResolver — customer', () => {
  it('exact name match returns resolved with score 1.0', async () => {
    const { pool } = makeMockPool([
      undefined, // SET tenant context
      [{ id: 'cust-1', display_name: 'Rodriguez HVAC', primary_phone: '555-1234', score: 1.0 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'Rodriguez HVAC',
      kind: 'customer',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe('cust-1');
      expect(result.candidate.score).toBe(1.0);
      expect(result.candidate.label).toBe('Rodriguez HVAC');
      expect(result.candidate.kind).toBe('customer');
    }
  });

  it('fuzzy match ("Rodrigez" → "Rodriguez") returns resolved with score < 1', async () => {
    const { pool } = makeMockPool([
      undefined,
      [{ id: 'cust-1', display_name: 'Rodriguez HVAC', primary_phone: null, score: 0.85 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'Rodrigez HVAC',
      kind: 'customer',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.score).toBeLessThan(1.0);
      expect(result.candidate.score).toBeGreaterThanOrEqual(0.80);
    }
  });

  it('two candidates above τ_ent returns ambiguous with both', async () => {
    const { pool } = makeMockPool([
      undefined,
      [
        { id: 'cust-1', display_name: 'Rodriguez Plumbing', primary_phone: null, score: 0.92 },
        { id: 'cust-2', display_name: 'Rodriguez HVAC', primary_phone: null, score: 0.88 },
      ],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'Rodriguez',
      kind: 'customer',
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0].id).toBe('cust-1');
      expect(result.candidates[1].id).toBe('cust-2');
    }
  });

  it('no candidate above τ_ent returns not_found', async () => {
    const { pool } = makeMockPool([
      undefined,
      [{ id: 'cust-9', display_name: 'Unrelated Company', primary_phone: null, score: 0.35 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'Nonexistent Corp',
      kind: 'customer',
    });

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') {
      expect(result.reference).toBe('Nonexistent Corp');
    }
  });

  it('empty results from DB returns not_found', async () => {
    const { pool } = makeMockPool([undefined, []]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'Nobody',
      kind: 'customer',
    });

    expect(result.kind).toBe('not_found');
  });

  it('tenant isolation — SQL always includes tenant_id = $1', async () => {
    const { pool, calls } = makeMockPool([
      undefined,
      [{ id: 'cust-1', display_name: 'ACME', primary_phone: null, score: 0.95 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'ACME',
      kind: 'customer',
    });

    // Business query (not the SET context call) must parameterize tenant_id
    const businessQuery = calls.find((c) => c.sql.includes('FROM customers'));
    expect(businessQuery).toBeDefined();
    expect(businessQuery!.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(businessQuery!.params[0]).toBe(TENANT_ID);
    // tenantId must NOT be interpolated into the SQL string
    expect(businessQuery!.sql).not.toContain(TENANT_ID);
  });

  it('only one candidate exactly at τ_ent boundary (0.80) → resolved', async () => {
    const { pool } = makeMockPool([
      undefined,
      [{ id: 'cust-1', display_name: 'Boundary Corp', primary_phone: null, score: 0.80 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'Boundary',
      kind: 'customer',
    });

    expect(result.kind).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// Empty / null input → skipped
// ---------------------------------------------------------------------------

describe('PgEntityResolver — empty/null input', () => {
  it('empty string reference returns skipped', async () => {
    const { pool } = makeMockPool([]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: '',
      kind: 'customer',
    });

    expect(result.kind).toBe('skipped');
  });

  it('whitespace-only reference returns skipped', async () => {
    const { pool } = makeMockPool([]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: '   ',
      kind: 'customer',
    });

    expect(result.kind).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// Job resolution
// ---------------------------------------------------------------------------

describe('PgEntityResolver — job', () => {
  it('single fuzzy job match above τ_ent returns resolved', async () => {
    const { pool, calls } = makeMockPool([
      undefined,
      [{ id: 'job-1', summary: 'HVAC Repair - Smith', status: 'open', score: 0.82 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'HVAC Repair Smith',
      kind: 'job',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe('job-1');
      expect(result.candidate.kind).toBe('job');
    }

    // Verify tenant isolation in job query
    const businessQuery = calls.find((c) => c.sql.includes('FROM jobs'));
    expect(businessQuery!.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(businessQuery!.params[0]).toBe(TENANT_ID);
  });

  it('no job match above τ_ent returns not_found', async () => {
    const { pool } = makeMockPool([
      undefined,
      [{ id: 'job-9', summary: 'Plumbing Fix', status: 'open', score: 0.45 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'Electrical Panel Install',
      kind: 'job',
    });

    expect(result.kind).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Invoice resolution
// ---------------------------------------------------------------------------

describe('PgEntityResolver — invoice', () => {
  it('exact invoice number match returns resolved before trigram', async () => {
    const { pool, calls } = makeMockPool([
      undefined,
      [{ id: 'inv-exact', doc_number: 'INV-0042', status: 'sent' }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'inv-0042',
      kind: 'invoice',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe('inv-exact');
      expect(result.candidate.score).toBe(1.0);
    }

    const exactQuery = calls.find((c) => c.sql.includes('FROM invoices'));
    expect(exactQuery!.sql).toMatch(/UPPER\(invoice_number\)\s*=\s*UPPER\(\$2\)/);
    expect(exactQuery!.params[1]).toBe('inv-0042');
  });

  it('matching invoice number returns resolved via trigram when no exact row', async () => {
    const { pool, calls } = makeMockPool([
      undefined,
      [], // exact match miss
      [{ id: 'inv-1', invoice_number: 'INV-0042', status: 'sent', score: 1.0 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'INV-0042',
      kind: 'invoice',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.label).toBe('INV-0042');
    }

    const businessQueries = calls.filter((c) => c.sql.includes('FROM invoices'));
    expect(businessQueries).toHaveLength(2);
    expect(businessQueries[0]!.sql).toMatch(/UPPER\(invoice_number\)/);
    expect(businessQueries[1]!.sql).toMatch(/similarity\(invoice_number/);
    expect(businessQueries[1]!.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(businessQueries[1]!.params[0]).toBe(TENANT_ID);
  });

  it('two invoice candidates above τ_ent returns ambiguous', async () => {
    const { pool } = makeMockPool([
      undefined,
      [
        { id: 'inv-1', invoice_number: 'INV-0042', status: 'sent', score: 0.90 },
        { id: 'inv-2', invoice_number: 'INV-0043', status: 'draft', score: 0.85 },
      ],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'INV-004',
      kind: 'invoice',
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Appointment resolution
// ---------------------------------------------------------------------------

describe('PgEntityResolver — appointment', () => {
  it('unparseable date reference returns not_found', async () => {
    const { pool } = makeMockPool([]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'whenever',
      kind: 'appointment',
    });

    expect(result.kind).toBe('not_found');
  });

  it('parseable date with no DB rows returns not_found', async () => {
    const { pool } = makeMockPool([undefined, []]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'tomorrow',
      kind: 'appointment',
    });

    expect(result.kind).toBe('not_found');
  });

  it('parseable date with single DB row returns resolved', async () => {
    const futureDate = new Date();
    futureDate.setUTCDate(futureDate.getUTCDate() + 1);

    const { pool, calls } = makeMockPool([
      undefined,
      [
        {
          id: 'appt-1',
          scheduled_start: futureDate.toISOString(),
          status: 'scheduled',
        },
      ],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'tomorrow',
      kind: 'appointment',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe('appt-1');
    }

    // Verify tenant isolation
    const businessQuery = calls.find((c) => c.sql.includes('FROM appointments'));
    expect(businessQuery!.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(businessQuery!.params[0]).toBe(TENANT_ID);
  });

  it('parseable date with multiple rows returns ambiguous', async () => {
    const futureDate = new Date();
    futureDate.setUTCDate(futureDate.getUTCDate() + 1);

    const { pool } = makeMockPool([
      undefined,
      [
        { id: 'appt-1', scheduled_start: futureDate.toISOString(), status: 'scheduled' },
        { id: 'appt-2', scheduled_start: futureDate.toISOString(), status: 'scheduled' },
      ],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'tomorrow',
      kind: 'appointment',
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Estimate kind → skipped (no index defined)
// ---------------------------------------------------------------------------

describe('PgEntityResolver — estimate', () => {
  it('exact estimate number returns resolved with score 1.0', async () => {
    const { pool, calls } = makeMockPool([
      undefined,
      [{ id: 'est-1', doc_number: 'EST-0042', status: 'draft' }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'EST-0042',
      kind: 'estimate',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe('est-1');
      expect(result.candidate.label).toBe('EST-0042');
      expect(result.candidate.score).toBe(1.0);
    }

    const businessQuery = calls.find((c) => c.sql.includes('FROM estimates'));
    expect(businessQuery!.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(businessQuery!.sql).toMatch(/UPPER\(estimate_number\)\s*=\s*UPPER\(\$2\)/);
    expect(businessQuery!.params[0]).toBe(TENANT_ID);
  });

  it('unknown estimate number returns not_found', async () => {
    const { pool } = makeMockPool([undefined, []]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'EST-9999',
      kind: 'estimate',
    });

    expect(result.kind).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

describe('PgEntityResolver — connection management', () => {
  it('releases the connection even when query throws', async () => {
    const errorClient: Partial<PoolClient> = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error('pg connection lost')) // set_config → throws
        .mockResolvedValue({ rows: [], rowCount: 0 }), // ROLLBACK (cleanup)
      release: vi.fn(),
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => errorClient as PoolClient) as unknown as Pool['connect'],
    };

    const resolver = new PgEntityResolver(pool as Pool);
    await expect(
      resolver.resolve({ tenantId: TENANT_ID, reference: 'Bob', kind: 'customer' }),
    ).rejects.toThrow('pg connection lost');

    expect(errorClient.release).toHaveBeenCalledTimes(1);
  });
});
