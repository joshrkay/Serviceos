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
      await seedJob(pool, tenant.tenantId, tenant.userId);

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
      await seedAuditEvents(pool, tenant.tenantId, 20);

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

async function seedJob(pool: Pool, tenantId: string, technicianId: string): Promise<string> {
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

  const jobId = crypto.randomUUID();
  const jobNumber = `JOB-${jobId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary,
       status, priority, assigned_technician_id, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', 'normal', $7, $8, NOW(), NOW())`,
    [jobId, tenantId, customerId, locationId, jobNumber, 'Test job', technicianId, technicianId],
  );
  return jobId;
}

async function seedAuditEvents(pool: Pool, tenantId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - ($8 || ' seconds')::interval)`,
      [
        crypto.randomUUID(),
        tenantId,
        'test-actor',
        'owner',
        'test.event',
        'job',
        crypto.randomUUID(),
        i,
      ],
    );
  }
}
