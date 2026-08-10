import { describe, it, expect, vi } from 'vitest';
import { Pool, PoolClient, QueryResult } from 'pg';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { ConflictError } from '../../src/shared/errors';

/**
 * Blocker 7 — rescheduling an appointment into a slot where its assigned
 * technician is already booked fires the migration-131 sync trigger, whose
 * UPDATE of appointment_assignments violates the `no_double_booking`
 * EXCLUDE constraint (SQLSTATE 23P01). PgAppointmentRepository must map
 * that to ConflictError so PUT /api/appointments/:id returns 409, not 500.
 */
describe('PgAppointmentRepository — DB conflict mapping', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  function buildErrorPool(err: unknown) {
    const releases: number[] = [];
    const client: Partial<PoolClient> = {
      // U2b-2: reject the BUSINESS statement (UPDATE) by content — the SET LOCAL
      // transaction now frames it with BEGIN/set_config/COMMIT/RESET, so a
      // positional mock would throw on the wrong call.
      query: vi.fn(async (sql: string) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b|SELECT set_config)/i.test(sql)) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        throw err;
      }) as unknown as PoolClient['query'],
      release: vi.fn(() => {
        releases.push(1);
      }) as unknown as PoolClient['release'],
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
    };
    return { pool: pool as Pool, releases };
  }

  it('maps EXCLUDE-constraint violation (23P01 / no_double_booking) on UPDATE to ConflictError (409)', async () => {
    const pgErr = Object.assign(
      new Error('conflicting key value violates exclusion constraint "no_double_booking"'),
      { code: '23P01', constraint: 'no_double_booking' },
    );
    const { pool, releases } = buildErrorPool(pgErr);
    const repo = new PgAppointmentRepository(pool);

    let caught: unknown;
    try {
      await repo.update(tenantId, 'appt-1', {
        scheduledStart: new Date('2026-04-20T14:00:00Z'),
        scheduledEnd: new Date('2026-04-20T15:00:00Z'),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).statusCode).toBe(409);
    expect((caught as Error).message).toMatch(/already booked/i);
    // Client released exactly once even though the UPDATE threw.
    expect(releases).toHaveLength(1);
  });

  it('does not mask unrelated DB errors on UPDATE as ConflictError', async () => {
    const pgErr = Object.assign(new Error('connection terminated'), { code: '08006' });
    const { pool } = buildErrorPool(pgErr);
    const repo = new PgAppointmentRepository(pool);

    let caught: unknown;
    try {
      await repo.update(tenantId, 'appt-1', { notes: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ConflictError);
    expect((caught as Error).message).toMatch(/connection terminated/);
  });
});

/**
 * U2 — releasing the idempotency key on cancel. Regression guard for the
 * BLOCKER the deepening review found: the `update` fieldMap had no
 * `idempotencyKey` entry, so `update({ idempotencyKey: null })` was silently
 * dropped and the canonical job-schedule key never cleared — meaning a later
 * reschedule would dedupe back into the canceled row. This pins that the SET
 * clause is emitted and the value is SQL NULL. (The end-to-end NULL write is
 * proven against real Postgres in the integration suite.)
 */
describe('PgAppointmentRepository — releasable idempotency_key', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  function buildCapturePool() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: Partial<PoolClient> = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b|SELECT set_config)/i.test(sql)) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        calls.push({ sql, params: params ?? [] });
        return {
          rows: [
            {
              id: 'appt-1', tenant_id: tenantId, job_id: 'job-1',
              scheduled_start: '2026-04-20T14:00:00Z', scheduled_end: '2026-04-20T15:00:00Z',
              timezone: 'UTC', status: 'canceled', hold_pending_approval: false,
              idempotency_key: null, notes: null, created_by: 'u1',
              created_at: '2026-04-20T00:00:00Z', updated_at: '2026-04-20T00:00:00Z',
            },
          ],
          rowCount: 1,
        } as unknown as QueryResult;
      }) as unknown as PoolClient['query'],
      release: vi.fn() as unknown as PoolClient['release'],
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
    };
    return { pool: pool as Pool, calls };
  }

  it('emits an idempotency_key SET clause that writes SQL NULL when releasing the key', async () => {
    const { pool, calls } = buildCapturePool();
    const repo = new PgAppointmentRepository(pool);

    await repo.update(tenantId, 'appt-1', { status: 'canceled', idempotencyKey: null });

    const update = calls.find((c) => /UPDATE appointments SET/i.test(c.sql));
    expect(update).toBeDefined();
    const match = update!.sql.match(/idempotency_key = \$(\d+)/);
    expect(match).not.toBeNull();
    // The releasing value lands at its parameter position as a real NULL.
    const paramPos = Number(match![1]) - 1;
    expect(update!.params[paramPos]).toBeNull();
  });
});

/**
 * PR #815 review, Important 4 — `appointmentType` is a field of `Appointment`
 * (appointments/appointment.ts) and `mapRow` above reads it back from
 * `appointment_type`, but the `update` fieldMap omitted it — so
 * `PgAppointmentRepository.update(tenantId, id, { appointmentType })`
 * silently discarded the field while `InMemoryAppointmentRepository.update`
 * (a plain object spread) applied it. Exactly the divergence class this PR
 * exists to close: no current caller updates this field (dormant), but a
 * repo-interface method should not divergently drop a documented field of
 * its own entity depending on which backend is live.
 */
describe('PgAppointmentRepository — update() field-map completeness', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  function buildCapturePool() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: Partial<PoolClient> = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b|SELECT set_config)/i.test(sql)) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        calls.push({ sql, params: params ?? [] });
        return {
          rows: [
            {
              id: 'appt-1', tenant_id: tenantId, job_id: 'job-1',
              scheduled_start: '2026-04-20T14:00:00Z', scheduled_end: '2026-04-20T15:00:00Z',
              timezone: 'UTC', status: 'scheduled', hold_pending_approval: false,
              idempotency_key: null, notes: null, appointment_type: 'repair', created_by: 'u1',
              created_at: '2026-04-20T00:00:00Z', updated_at: '2026-04-20T00:00:00Z',
            },
          ],
          rowCount: 1,
        } as unknown as QueryResult;
      }) as unknown as PoolClient['query'],
      release: vi.fn() as unknown as PoolClient['release'],
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
    };
    return { pool: pool as Pool, calls };
  }

  it('emits an appointment_type SET clause instead of silently dropping the field', async () => {
    const { pool, calls } = buildCapturePool();
    const repo = new PgAppointmentRepository(pool);

    await repo.update(tenantId, 'appt-1', { appointmentType: 'repair' });

    const update = calls.find((c) => /UPDATE appointments SET/i.test(c.sql));
    expect(update).toBeDefined();
    const match = update!.sql.match(/appointment_type = \$(\d+)/);
    expect(match).not.toBeNull();
    const paramPos = Number(match![1]) - 1;
    expect(update!.params[paramPos]).toBe('repair');
  });
});

/**
 * Follow-up — technicianId filter parity with InMemoryAppointmentRepository.
 *
 * Pins the shape of Pg's technicianId filter (an EXISTS subquery against
 * `appointment_assignments`, scoped to the same tenant as the appointment)
 * so a change here that silently drops the filter is caught the same way
 * the in-memory equivalent is pinned in in-memory-appointment.test.ts.
 * Without real Postgres this can only assert the query SHAPE, not that the
 * DB actually filters correctly — that end-to-end proof lives in the
 * Docker-gated integration test
 * (test/integration/dispatch-technician-day-window.test.ts).
 */
describe('PgAppointmentRepository — technicianId filter (parity with InMemory)', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  function buildCapturePool() {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: Partial<PoolClient> = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b|SELECT set_config)/i.test(sql)) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        calls.push({ sql, params: params ?? [] });
        if (/^SELECT COUNT/i.test(sql)) {
          return { rows: [{ total: 0 }], rowCount: 1 } as unknown as QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }) as unknown as PoolClient['query'],
      release: vi.fn() as unknown as PoolClient['release'],
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
    };
    return { pool: pool as Pool, calls };
  }

  it('emits an EXISTS subquery against appointment_assignments, scoped to the same tenant, when technicianId is set', async () => {
    const { pool, calls } = buildCapturePool();
    const repo = new PgAppointmentRepository(pool);

    // A real UUID: `technician_id` is `UUID NOT NULL`, and the repository
    // short-circuits a value that could not match it (review N5), so a
    // placeholder id here would prove nothing about the emitted SQL.
    const technicianId = '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
    await repo.listWithMeta(tenantId, { technicianId });

    const dataQuery = calls.find((c) => /^SELECT a\.\* FROM appointments/i.test(c.sql));
    expect(dataQuery).toBeDefined();
    expect(dataQuery!.sql).toMatch(
      /EXISTS \(SELECT 1 FROM appointment_assignments aa\s+WHERE aa\.appointment_id = a\.id\s+AND aa\.tenant_id = a\.tenant_id\s+AND aa\.technician_id = \$\d+\)/
    );
    expect(dataQuery!.params).toContain(technicianId);

    // The count query shares the same WHERE clause (and therefore the same
    // filter), so pagination totals agree with the returned page.
    const countQuery = calls.find((c) => /^SELECT COUNT/i.test(c.sql));
    expect(countQuery).toBeDefined();
    expect(countQuery!.sql).toMatch(/EXISTS \(SELECT 1 FROM appointment_assignments aa/);
  });

  it('omits the EXISTS subquery entirely when technicianId is not set', async () => {
    const { pool, calls } = buildCapturePool();
    const repo = new PgAppointmentRepository(pool);

    await repo.listWithMeta(tenantId, {});

    const dataQuery = calls.find((c) => /^SELECT a\.\* FROM appointments/i.test(c.sql));
    expect(dataQuery!.sql).not.toMatch(/appointment_assignments/);
  });
});

/**
 * Follow-up review N5 — `appointments.job_id` and
 * `appointment_assignments.technician_id` are both `UUID NOT NULL`
 * (db/schema.ts). The appointments route deliberately does NOT trim a
 * filter value, on the correct reasoning that `?technicianId=%20` is a
 * caller asserting a value rather than asking for no filter. Its comment
 * then claimed the result was "an honest zero-result filter" — and that
 * was FALSE at this layer: Postgres raises `invalid input syntax for type
 * uuid` on the comparison, so the operator got a 500, not an empty list.
 *
 * Fixed here rather than at the route, using the idiom this codebase
 * already established for exactly this (`isUuid` short-circuit in
 * materials/pg-material-item.ts): a filter value that cannot possibly
 * match a UUID column matches nothing, which is what the route's comment
 * always claimed and is honest. Trimming instead would be worse than the
 * bug: a whitespace-only technicianId would silently become "no filter"
 * and widen the response to every appointment in the tenant — the exact
 * widening the empty-param fix removed.
 */
describe('PgAppointmentRepository — non-UUID filter values', () => {
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  function buildCountingPool() {
    const businessSql: string[] = [];
    const client: Partial<PoolClient> = {
      query: vi.fn(async (sql: string) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b|SELECT set_config)/i.test(sql)) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        businessSql.push(sql);
        // Any real execution against a UUID column with these values would
        // raise 22P02; the point of the assertions below is that we never
        // get here.
        return { rows: [{ total: 0 }], rowCount: 0 } as unknown as QueryResult;
      }) as unknown as PoolClient['query'],
      release: vi.fn() as unknown as PoolClient['release'],
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
    };
    return { pool: pool as Pool, businessSql };
  }

  for (const value of [' ', '   ', 'tech-1', 'not-a-uuid']) {
    it(`listWithMeta returns an empty page for technicianId=${JSON.stringify(value)} without querying`, async () => {
      const { pool, businessSql } = buildCountingPool();
      const repo = new PgAppointmentRepository(pool);

      const result = await repo.listWithMeta(tenantId, { technicianId: value });

      expect(result).toEqual({ data: [], total: 0 });
      expect(businessSql).toHaveLength(0);
    });

    it(`listWithMeta returns an empty page for jobId=${JSON.stringify(value)} without querying`, async () => {
      const { pool, businessSql } = buildCountingPool();
      const repo = new PgAppointmentRepository(pool);

      const result = await repo.listWithMeta(tenantId, { jobId: value });

      expect(result).toEqual({ data: [], total: 0 });
      expect(businessSql).toHaveLength(0);
    });

    it(`findByJob returns an empty list for jobId=${JSON.stringify(value)} without querying`, async () => {
      const { pool, businessSql } = buildCountingPool();
      const repo = new PgAppointmentRepository(pool);

      expect(await repo.findByJob(tenantId, value)).toEqual([]);
      expect(businessSql).toHaveLength(0);
    });
  }

  it('a well-formed UUID filter still reaches the database', async () => {
    const { pool, businessSql } = buildCountingPool();
    const repo = new PgAppointmentRepository(pool);

    await repo.listWithMeta(tenantId, { technicianId: '11111111-2222-3333-4444-555555555555' });

    expect(businessSql.length).toBeGreaterThan(0);
    expect(businessSql.some((sql) => /appointment_assignments/i.test(sql))).toBe(true);
  });
});
