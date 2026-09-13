import { describe, it, expect, beforeAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';

/**
 * DATA-01 / DATA-02 — composite indexes for two hot read paths that
 * previously had no covering index and fell back to a sequential scan
 * (DATA-01) or an index-filter-plus-Sort (DATA-02) as the tables grow:
 *
 *  - DATA-01: PgJobRepository.buildListWhere adds `assigned_technician_id =
 *    $N` when `JobListOptions.technicianId` is supplied (reachable via
 *    `GET /api/jobs?technicianId=` in routes/jobs.ts, and via
 *    reports/technician-profit.ts). jobs previously only had
 *    idx_jobs_tenant (tenant_id alone) and idx_jobs_status
 *    (tenant_id, status) — neither covers this filter.
 *  - DATA-02: PgAuditRepository.findByTenant runs `SELECT * FROM
 *    audit_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT
 *    $2`. audit_events previously only had idx_audit_tenant (tenant_id
 *    alone), so the ORDER BY needed a separate Sort once the table grew
 *    past what fits cheaply in a sort buffer — and every mutation in the
 *    app emits an audit event, so this table is unbounded and
 *    append-only.
 *
 * Migrations: 244_jobs_tenant_assigned_technician_index,
 * 245_audit_events_tenant_created_at_index (packages/api/src/db/schema.ts).
 */
describe('DATA-01/02: jobs + audit_events tenant composite indexes', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  it('creates idx_jobs_tenant_assigned_technician on jobs(tenant_id, assigned_technician_id)', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'jobs' AND indexname = 'idx_jobs_tenant_assigned_technician'`,
    );
    expect(rows).toHaveLength(1);
    const def: string = rows[0].indexdef;
    expect(def).toMatch(/ON public\.jobs USING btree \(tenant_id, assigned_technician_id\)/);
  });

  it('creates idx_audit_events_tenant_created_at on audit_events(tenant_id, created_at DESC)', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'audit_events' AND indexname = 'idx_audit_events_tenant_created_at'`,
    );
    expect(rows).toHaveLength(1);
    const def: string = rows[0].indexdef;
    expect(def).toMatch(/ON public\.audit_events USING btree \(tenant_id, created_at DESC\)/);
  });

  it('does not collide with any pre-existing index name on jobs or audit_events', async () => {
    const { rows } = await pool.query(
      `SELECT tablename, indexname FROM pg_indexes
        WHERE tablename IN ('jobs', 'audit_events')`,
    );
    const names = rows.map((r: { indexname: string }) => r.indexname);
    // No duplicates — CREATE INDEX IF NOT EXISTS would silently no-op a
    // name collision against a differently-defined existing index rather
    // than erroring, so uniqueness has to be checked explicitly.
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('idx_jobs_tenant_assigned_technician');
    expect(names).toContain('idx_audit_events_tenant_created_at');
  });

  describe('query plans reach for the new indexes', () => {
    // Determinism note: a freshly-seeded test table has too few heap pages
    // for Postgres' cost-based planner to ever prefer an index scan over a
    // sequential scan, regardless of how selective the predicate is — the
    // planner isn't wrong to pick Seq Scan on a tiny table. Rather than
    // insert enough rows to flip that naturally (slow, and still not
    // fully deterministic across CI hardware), each check below sets
    // `enable_seqscan = off` for the duration of a transaction, which
    // forces the planner to choose among *index-capable* plans. That lets
    // us assert deterministically that the plan reaches for the specific
    // NEW index (not some other index on the table, and not a Seq Scan +
    // Sort) — a structural assertion on the plan text, not a cost-number
    // comparison, so it isn't version-sensitive the way asserting exact
    // costs would be.
    it('EXPLAIN for the technicianId job-list filter uses idx_jobs_tenant_assigned_technician', async () => {
      const tenant = await createTestTenant(pool);
      // #909 CI blocker (2026-08-31) — root cause + fix. `enable_seqscan =
      // off` only rules OUT sequential scans; it does NOT force the
      // COMPOSITE index specifically over idx_jobs_tenant (tenant_id
      // alone) + an in-memory Filter on assigned_technician_id — both are
      // "index-capable" plans for this predicate. With the OLD fixture
      // (a single seeded job), a match via EITHER index costs the planner
      // about the same, so the choice comes down to whatever `jobs`
      // table-wide stats (assigned_technician_id's null_frac/n_distinct)
      // ANALYZE last happened to sample — and `getSharedTestDb()` is ONE
      // Postgres instance for the entire `vitest run`, so those stats
      // drift with whatever OTHER integration tests seeded into `jobs`
      // before this one ran. That made the assertion a coin flip: green
      // in isolation (nothing else had touched `jobs` yet) and on most
      // full runs, but reproducibly red on this PR's CI once its own new
      // fixtures (the A19 chat-entity-resolution work) shifted that
      // accumulated state enough to tip the flip.
      //
      // An explicit ANALYZE alone does not fix this — it makes the
      // planner's estimate accurate, and an accurate estimate for "1
      // seeded row, no real competing rows on this tenant" is exactly
      // what made idx_jobs_tenant (the smaller, simpler index) a
      // legitimate, sometimes-cheaper choice; the assertion was brittle
      // BY DESIGN on a single-row table, independent of stats freshness.
      // The actual fix (mirroring DATA-02's audit_events fix immediately
      // below, same root cause) is to seed a query shape where the
      // composite index is genuinely, decisively superior: many jobs on
      // ONE tenant, only one of them assigned to the technician EXPLAIN
      // filters for. idx_jobs_tenant + Filter must then visit and reject
      // every OTHER job on that tenant; the composite index narrows
      // straight to the one match via its second key column — the real
      // difference DATA-01 exists to make (`GET /api/jobs?technicianId=`
      // on a shop with many jobs, most unassigned or assigned elsewhere).
      // ANALYZE is kept: correct hygiene, and it's what makes the now-
      // accurate row/selectivity estimate for THIS shape land where it
      // should regardless of any other test's leftover `jobs` stats.
      await seedManyJobsOneAssignedToTechnician(pool, tenant.tenantId, tenant.userId, 25);
      await pool.query('ANALYZE jobs');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const plan = await explain(
          client,
          `SELECT * FROM jobs WHERE tenant_id = $1 AND assigned_technician_id = $2`,
          [tenant.tenantId, tenant.userId],
        );
        expect(plan).toMatch(/idx_jobs_tenant_assigned_technician/);
        expect(plan).not.toMatch(/Seq Scan on jobs/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('EXPLAIN for the audit-events recent-events read uses idx_audit_events_tenant_created_at', async () => {
      const tenant = await createTestTenant(pool);
      // Seed MORE than the query's LIMIT (50) and ANALYZE so the planner's row
      // estimate is accurate. With >LIMIT rows the composite (tenant_id,
      // created_at DESC) index can walk in order and stop after 50, which is
      // decisively cheaper than the tenant-only index's scan-all + Sort — so
      // the planner reliably picks it. Without this (e.g. only 20 rows) the two
      // plans cost within a hair of each other and the choice is non-
      // deterministic across environments (a competing idx_audit_tenant wins on
      // CI while losing locally).
      await seedAuditEvents(pool, tenant.tenantId, 200);
      await pool.query('ANALYZE audit_events');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const plan = await explain(
          client,
          `SELECT * FROM audit_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
          [tenant.tenantId, 50],
        );
        expect(plan).toMatch(/idx_audit_events_tenant_created_at/);
        // The composite index already returns rows in (tenant_id,
        // created_at DESC) order, so with the new index available the
        // planner should not need a separate Sort node to satisfy the
        // ORDER BY.
        expect(plan).not.toMatch(/\bSort\b/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});

async function explain(
  client: PoolClient,
  sql: string,
  params: unknown[],
): Promise<string> {
  const { rows } = await client.query(`EXPLAIN ${sql}`, params);
  return rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
}

/**
 * ONE customer + location, then `totalJobs` jobs on that tenant — only the
 * FIRST is assigned to `technicianId` (the id the technicianId-filter test
 * above EXPLAINs for); the rest are unassigned (`assigned_technician_id
 * IS NULL`, the ordinary "nobody dispatched yet" state, not a fabricated
 * one — see migration 244's own doc comment on why the composite index is
 * plain, not partial: it also serves an IS NULL/IS NOT NULL scan). This
 * shape is what makes the composite index decisively cheaper than
 * idx_jobs_tenant + Filter (which must visit and reject every other job on
 * the tenant) — see the doc comment on the test above for why a single
 * seeded job made that comparison an unreliable coin flip instead.
 * Batched via generate_series (mirrors seedAuditEvents below) so 25+ rows
 * stay fast to seed.
 */
async function seedManyJobsOneAssignedToTechnician(
  pool: Pool,
  tenantId: string,
  technicianId: string,
  totalJobs: number,
): Promise<void> {
  const customerId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [customerId, tenantId, 'Test', 'Customer', 'Test Customer', technicianId],
  );

  const locationId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code, country)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [locationId, tenantId, customerId, '1 Main St', 'Phoenix', 'AZ', '85001', 'US'],
  );

  await pool.query(
    `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary,
       status, priority, assigned_technician_id, created_by, created_at, updated_at)
     SELECT gen_random_uuid(), $1, $2, $3,
            'JOB-' || substr(gen_random_uuid()::text, 1, 8),
            'Test job', 'scheduled', 'normal',
            CASE WHEN g = 0 THEN $4::uuid ELSE NULL END,
            $4, NOW(), NOW()
       FROM generate_series(0, $5 - 1) AS g`,
    [tenantId, customerId, locationId, technicianId, totalJobs],
  );
}

async function seedAuditEvents(pool: Pool, tenantId: string, count: number): Promise<void> {
  // Batched set-based insert (generate_series) so seeding hundreds of rows for
  // the planner-estimate test stays fast. Each row gets a distinct created_at
  // (NOW() - N seconds) so the ORDER BY created_at DESC has a real ordering.
  await pool.query(
    `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, created_at)
     SELECT gen_random_uuid(), $1, 'test-actor', 'owner', 'test.event', 'job', gen_random_uuid(),
            NOW() - (g || ' seconds')::interval
     FROM generate_series(0, $2 - 1) AS g`,
    [tenantId, count],
  );
}
