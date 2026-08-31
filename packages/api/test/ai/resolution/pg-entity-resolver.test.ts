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
  job_id?: string;
  name?: string;
  unit_price_cents?: number;
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
// toResult confidence bands (τ_ent = 0.80 / τ_ent_confirm_low = 0.60)
// ---------------------------------------------------------------------------

describe('PgEntityResolver — toResult confidence bands', () => {
  async function resolveWithScore(score: number) {
    const { pool } = makeMockPool([
      undefined,
      [{ id: 'cust-1', display_name: 'Boundary Corp', primary_phone: null, score }],
    ]);
    const resolver = new PgEntityResolver(pool);
    return resolver.resolve({ tenantId: TENANT_ID, reference: 'Boundary', kind: 'customer' });
  }

  it('0.85 (above τ_ent) → resolved', async () => {
    const result = await resolveWithScore(0.85);
    expect(result.kind).toBe('resolved');
  });

  it('0.80 (at τ_ent) → resolved', async () => {
    const result = await resolveWithScore(0.80);
    expect(result.kind).toBe('resolved');
  });

  it('0.70 (regression case: mid-band) → low_confidence, NOT resolved or not_found', async () => {
    const result = await resolveWithScore(0.70);
    expect(result.kind).toBe('low_confidence');
    if (result.kind === 'low_confidence') {
      expect(result.candidate.id).toBe('cust-1');
      expect(result.candidate.score).toBe(0.70);
    }
  });

  it('0.60 (at τ_ent_confirm_low) → low_confidence', async () => {
    const result = await resolveWithScore(0.60);
    expect(result.kind).toBe('low_confidence');
  });

  it('0.59 (just below τ_ent_confirm_low) → not_found', async () => {
    const result = await resolveWithScore(0.59);
    expect(result.kind).toBe('not_found');
  });

  it('0.30 (well below τ_ent_confirm_low) → not_found', async () => {
    const result = await resolveWithScore(0.30);
    expect(result.kind).toBe('not_found');
  });

  it('two candidates in the mid-band → ambiguous', async () => {
    const { pool } = makeMockPool([
      undefined,
      [
        { id: 'cust-1', display_name: 'Rodriguez Plumbing', primary_phone: null, score: 0.72 },
        { id: 'cust-2', display_name: 'Rodriguez HVAC', primary_phone: null, score: 0.65 },
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
    }
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
// SCH-03 — job-scoped appointment fallback ("that job" isn't a date phrase)
// ---------------------------------------------------------------------------

describe('PgEntityResolver — appointment job-scoped fallback (SCH-03)', () => {
  const JOB_ID = 'job-42';

  it('unparseable reference + jobId + one upcoming appointment → resolved', async () => {
    const futureDate = new Date();
    futureDate.setUTCDate(futureDate.getUTCDate() + 3);

    const { pool, calls } = makeMockPool([
      undefined,
      [
        {
          id: 'appt-job-1',
          job_id: JOB_ID,
          scheduled_start: futureDate.toISOString(),
          status: 'scheduled',
        },
      ],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'that job',
      kind: 'appointment',
      jobId: JOB_ID,
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe('appt-job-1');
      expect(result.candidate.kind).toBe('appointment');
    }

    const businessQuery = calls.find((c) => c.sql.includes('FROM appointments'));
    expect(businessQuery).toBeDefined();
    expect(businessQuery!.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(businessQuery!.sql).toMatch(/job_id\s*=\s*\$2/);
    expect(businessQuery!.sql).toMatch(/status\s*<>\s*'canceled'/);
    expect(businessQuery!.sql).toMatch(/scheduled_start\s*>=\s*now\(\)/);
    expect(businessQuery!.params).toEqual([TENANT_ID, JOB_ID]);
  });

  it('unparseable reference + jobId + two upcoming appointments → ambiguous', async () => {
    const futureDate = new Date();
    futureDate.setUTCDate(futureDate.getUTCDate() + 3);

    const { pool } = makeMockPool([
      undefined,
      [
        { id: 'appt-1', job_id: JOB_ID, scheduled_start: futureDate.toISOString(), status: 'scheduled' },
        { id: 'appt-2', job_id: JOB_ID, scheduled_start: futureDate.toISOString(), status: 'scheduled' },
      ],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'that job',
      kind: 'appointment',
      jobId: JOB_ID,
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.id)).toEqual(['appt-1', 'appt-2']);
    }
  });

  it('unparseable reference + jobId + zero upcoming appointments → not_found', async () => {
    const { pool } = makeMockPool([undefined, []]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'that job',
      kind: 'appointment',
      jobId: JOB_ID,
    });

    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') {
      expect(result.reference).toBe('that job');
    }
  });

  it('unparseable reference WITHOUT jobId now falls through to the tenant-scoped lookup', async () => {
    // Previously this asserted the resolver gave up WITHOUT touching the DB.
    // That early return was the SCH-03 bug: it made a first-turn cancel
    // escalate even when the tenant had exactly one upcoming appointment.
    const { pool, calls } = makeMockPool([undefined, []]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'that job',
      kind: 'appointment',
    });

    expect(result.kind).toBe('not_found');
    const apptQueries = calls.filter((c) => c.sql.includes('FROM appointments'));
    expect(apptQueries).toHaveLength(1);
    expect(apptQueries[0].sql).not.toMatch(/job_id/);
  });

  it('a PARSEABLE reference still uses the date-range query even when jobId is present (date wins)', async () => {
    const futureDate = new Date();
    futureDate.setUTCDate(futureDate.getUTCDate() + 1);

    const { pool, calls } = makeMockPool([
      undefined,
      [{ id: 'appt-date', scheduled_start: futureDate.toISOString(), status: 'scheduled' }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'tomorrow',
      kind: 'appointment',
      jobId: JOB_ID,
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe('appt-date');
    }
    const businessQuery = calls.find((c) => c.sql.includes('FROM appointments'));
    expect(businessQuery!.sql).not.toMatch(/job_id/);
  });
});

// ---------------------------------------------------------------------------
// SCH-03 — tenant-scoped upcoming-appointment fallback (no date, no jobId)
//
// The caller's FIRST sentence is "Cancel the upcoming appointment for that
// job." `context.jobId` is only ever written by a PRIOR turn that resolved a
// job (transitions.ts), so on turn one there is no job anchor, and "the
// upcoming appointment for that job" parses as no date. Before the fallback
// the resolver returned not_found here and inapp-adapter.ts's
// requiresExistingEntity guard escalated the caller to on-call.
// ---------------------------------------------------------------------------

describe('PgEntityResolver — tenant-scoped upcoming appointment fallback (SCH-03)', () => {
  function upcoming(id: string, daysOut: number) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysOut);
    return { id, scheduled_start: d.toISOString(), status: 'scheduled' };
  }

  it('reference="that job", no jobId, ONE upcoming tenant appointment → resolved', async () => {
    const { pool, calls } = makeMockPool([undefined, [upcoming('appt-only', 2)]]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'that job',
      kind: 'appointment',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe('appt-only');
      expect(result.candidate.kind).toBe('appointment');
    }

    // Same shape as resolveAppointmentByJob, minus job_id — and tenant-scoped.
    const businessQuery = calls.find((c) => c.sql.includes('FROM appointments'));
    expect(businessQuery).toBeDefined();
    expect(businessQuery!.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(businessQuery!.sql).toMatch(/status\s*<>\s*'canceled'/);
    expect(businessQuery!.sql).toMatch(/scheduled_start\s*>=\s*now\(\)/);
    expect(businessQuery!.sql).toMatch(/ORDER BY scheduled_start ASC/);
    expect(businessQuery!.sql).not.toMatch(/job_id/);
    expect(businessQuery!.params).toEqual([TENANT_ID]);
  });

  it('reference="that job", no jobId, THREE upcoming tenant appointments → ambiguous', async () => {
    const { pool } = makeMockPool([
      undefined,
      [upcoming('appt-1', 1), upcoming('appt-2', 2), upcoming('appt-3', 3)],
    ]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'that job',
      kind: 'appointment',
    });

    // Routed into the FSM's existing entity_ambiguous one-tap disambiguation
    // by inapp-adapter.ts toResolutionEvent — never a silent pick.
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.id)).toEqual(['appt-1', 'appt-2', 'appt-3']);
    }
  });

  it('reference="that job", no jobId, NO upcoming tenant appointments → not_found', async () => {
    const { pool } = makeMockPool([undefined, []]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'that job',
      kind: 'appointment',
    });

    // Still not_found — the 46a954e1 escalation guard must keep firing when a
    // record-operating intent has genuinely nothing to resolve.
    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') {
      expect(result.reference).toBe('that job');
    }
  });

  it('more candidates than the disambiguation cap → not_found, never a 5-of-many readback', async () => {
    const { pool, calls } = makeMockPool([
      undefined,
      [
        upcoming('appt-1', 1),
        upcoming('appt-2', 2),
        upcoming('appt-3', 3),
        upcoming('appt-4', 4),
        upcoming('appt-5', 5),
        upcoming('appt-6', 6),
      ],
    ]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'that job',
      kind: 'appointment',
    });

    expect(result.kind).toBe('not_found');
    // LIMIT 6 exists purely to detect "more than the 5 we can read back".
    const businessQuery = calls.find((c) => c.sql.includes('FROM appointments'));
    expect(businessQuery!.sql).toMatch(/LIMIT 6/);
  });

  it('a jobId anchor still wins over the tenant-wide fallback', async () => {
    const { pool, calls } = makeMockPool([undefined, [upcoming('appt-job', 2)]]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'that job',
      kind: 'appointment',
      jobId: 'job-99',
    });

    expect(result.kind).toBe('resolved');
    const businessQuery = calls.find((c) => c.sql.includes('FROM appointments'));
    expect(businessQuery!.sql).toMatch(/job_id\s*=\s*\$2/);
    expect(businessQuery!.params).toEqual([TENANT_ID, 'job-99']);
  });
});

// ---------------------------------------------------------------------------
// Estimate kind — exact document number, then customer → jobs → estimates
//
// SQL SHAPE ONLY. The Pool is mocked here, so these tests can say which query
// runs with which parameters and nothing more; whether the traversal actually
// finds an estimate is pinned against real Postgres in
// test/integration/entity-resolution.test.ts ("kind: estimate"), per the repo
// rule that a mocked-DB test is never the only proof a query works.
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

  it('a spoken reference falls back to the customer → jobs → estimates traversal, with the document noun stripped from the needle', async () => {
    const { pool, calls } = makeMockPool([undefined, []]);
    const resolver = new PgEntityResolver(pool);

    await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'the Garcia estimate',
      kind: 'estimate',
    });

    const traversal = calls.find((c) => c.sql.includes('JOIN customers'));
    expect(traversal).toBeDefined();
    expect(traversal!.sql).toMatch(/FROM estimates e/);
    expect(traversal!.sql).toMatch(/JOIN jobs j\s+ON j\.id = e\.job_id/);
    expect(traversal!.sql).toMatch(/JOIN customers c\s+ON c\.id = j\.customer_id/);
    expect(traversal!.sql).toMatch(/e\.tenant_id\s*=\s*\$1/);
    expect(traversal!.sql).toMatch(/e\.deleted_at IS NULL/);
    expect(traversal!.sql).toMatch(/c\.is_archived = false/);
    // Status floor (2026-08-31) — grounded in SendEstimateNudgeExecutionHandler
    // (only 'sent' is nudgeable) and UpdateEstimateExecutionHandler's
    // assertEstimateEditable (unconditional 'rejected'/'expired' refusal).
    expect(traversal!.sql).toMatch(/e\.status NOT IN \('rejected', 'expired'\)/);
    expect(traversal!.sql).toMatch(/strict_word_similarity\(\$2, c\.display_name\)/);
    // "the" is a shared stopword; "estimate" is the document noun. Both are
    // out of the needle — keeping either leaves the score under the confirm
    // floor (measurements in ESTIMATE_DOC_STOPWORDS' doc comment).
    expect(traversal!.params[1]).toBe('garcia');
    // The estimate row's OWN free text is never searched: matching
    // customer_message is the arrangement that made the nudge suite a false
    // green (docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-
    // nothing.md).
    expect(traversal!.sql).not.toMatch(/customer_message/);
  });

  it('a reference naming nobody ("the estimate") never issues the traversal query at all', async () => {
    const { pool, calls } = makeMockPool([undefined, []]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'the estimate',
      kind: 'estimate',
    });

    expect(result.kind).toBe('not_found');
    // An empty needle must not fan out across the tenant — the traversal is
    // skipped entirely rather than run with ''.
    expect(calls.find((c) => c.sql.includes('JOIN customers'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Catalog item resolution (#909, live sweeps 9/10)
// ---------------------------------------------------------------------------
//
// Mocked-Pool coverage only — per CLAUDE.md this is NOT sufficient alone for
// a new SQL path; see the Docker-gated integration suite in
// test/integration/entity-resolution.test.ts for the real-Postgres proof
// (real columns, real pg_trgm scoring, real archived_at exclusion).

describe('PgEntityResolver — catalogItem', () => {
  it('an exact name match resolves with score 1.0, priced hint', async () => {
    const { pool, calls } = makeMockPool([
      undefined,
      [{ id: 'ci-1', name: 'QA Sweep Smart Thermostat Install', unit_price_cents: 38500, score: 1.0 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'QA Sweep Smart Thermostat Install',
      kind: 'catalogItem',
    });

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.candidate.id).toBe('ci-1');
      expect(result.candidate.label).toBe('QA Sweep Smart Thermostat Install');
      expect(result.candidate.hint).toBe('$385.00');
      expect(result.candidate.score).toBe(1.0);
    }

    const businessQuery = calls.find((c) => c.sql.includes('FROM catalog_items'));
    expect(businessQuery!.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(businessQuery!.sql).toMatch(/archived_at IS NULL/);
    expect(businessQuery!.params[0]).toBe(TENANT_ID);
  });

  // The AI-catalog sweep's own live shape: `add_catalog_item` mints a fresh
  // "QA Sweep Smart Thermostat Install" every run with no cleanup between
  // runs, so by sweep round 9/10 the tenant carries two+ ACTIVE rows under
  // the identical name — the resolver must ask, never guess which one the
  // operator meant, even though the disambiguating detail (price) lives on
  // `hint`, not `label`.
  it('two identically-named duplicates (different prices) return ambiguous, never a guess', async () => {
    const { pool } = makeMockPool([
      undefined,
      [
        { id: 'ci-1', name: 'QA Sweep Smart Thermostat Install', unit_price_cents: 38500, score: 1.0 },
        { id: 'ci-2', name: 'QA Sweep Smart Thermostat Install', unit_price_cents: 8900, score: 1.0 },
      ],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'QA Sweep Smart Thermostat Install',
      kind: 'catalogItem',
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.hint)).toEqual(
        expect.arrayContaining(['$385.00', '$89.00']),
      );
    }
  });

  it('a partial name still resolves via strict_word_similarity', async () => {
    const { pool, calls } = makeMockPool([
      undefined,
      [{ id: 'ci-1', name: 'QA Sweep Smart Thermostat Install', unit_price_cents: 38500, score: 0.9 }],
    ]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'the thermostat install',
      kind: 'catalogItem',
    });

    expect(result.kind).toBe('resolved');
    const businessQuery = calls.find((c) => c.sql.includes('FROM catalog_items'));
    expect(businessQuery!.sql).toMatch(/strict_word_similarity\(\$2, name\)/);
  });

  it('no candidate above the prefilter returns not_found', async () => {
    const { pool } = makeMockPool([undefined, []]);
    const resolver = new PgEntityResolver(pool);

    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'flux capacitor',
      kind: 'catalogItem',
    });

    expect(result.kind).toBe('not_found');
  });

  it('excludes archived items from the candidate query', async () => {
    const { pool, calls } = makeMockPool([undefined, []]);
    const resolver = new PgEntityResolver(pool);

    await resolver.resolve({ tenantId: TENANT_ID, reference: 'anything', kind: 'catalogItem' });

    const businessQuery = calls.find((c) => c.sql.includes('FROM catalog_items'));
    expect(businessQuery!.sql).toMatch(/archived_at IS NULL/);
  });

  it('more confident matches than the picker ceiling escalates to not_found instead of an arbitrary five', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      id: `ci-${i}`,
      name: 'Filter replacement',
      unit_price_cents: 4500,
      score: 0.95,
    }));
    const { pool } = makeMockPool([undefined, rows]);

    const resolver = new PgEntityResolver(pool);
    const result = await resolver.resolve({
      tenantId: TENANT_ID,
      reference: 'filter',
      kind: 'catalogItem',
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
