import { vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { AppointmentAssignment } from '../../src/appointments/assignment';

/**
 * Lightweight mock for the `pg` Pool/PoolClient pair.
 *
 * Captures every executed query so tests can assert:
 *   * tenant_id is included in the WHERE clause (defense-in-depth)
 *   * SQL never concatenates tenantId into the string (parameterized only)
 *   * `set_config('app.current_tenant_id', ...)` is called before queries
 *     (tenant context for RLS)
 */
type CapturedCall = { sql: string; params: unknown[] };

function makeMockPool(rowsByCallIndex: Array<Record<string, unknown>[] | undefined>) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;

  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const rows = rowsByCallIndex[calls.length - 1] ?? [];
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
    calls,
    getReleaseCount: () => releaseCount,
  };
}

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function makeAssignment(overrides: Partial<AppointmentAssignment> = {}): AppointmentAssignment {
  return {
    id: 'assign-1',
    tenantId: TENANT_A,
    appointmentId: 'appt-1',
    technicianId: 'tech-1',
    isPrimary: true,
    assignedBy: 'dispatcher-1',
    assignedAt: new Date('2026-04-28T10:00:00.000Z'),
    ...overrides,
  };
}

function rowFor(a: AppointmentAssignment): Record<string, unknown> {
  return {
    id: a.id,
    tenant_id: a.tenantId,
    appointment_id: a.appointmentId,
    technician_id: a.technicianId,
    is_primary: a.isPrimary,
    assigned_by: a.assignedBy,
    assigned_at: a.assignedAt.toISOString(),
  };
}

describe('P0-019 — PgAssignmentRepository', () => {
  describe('PgAssignment.create', () => {
    it('PgAssignment inserts with parameterized values and sets tenant context', async () => {
      const assignment = makeAssignment();
      const { pool, calls, getReleaseCount } = makeMockPool([
        undefined, // set_config
        [rowFor(assignment)], // INSERT ... RETURNING *
      ]);

      const repo = new PgAssignmentRepository(pool);
      const result = await repo.create(assignment);

      // First call sets tenant context for RLS
      expect(calls[0].sql).toContain('app.current_tenant_id');
      expect(calls[0].sql).toContain(TENANT_A);

      // Second call is the INSERT — must be parameterized
      expect(calls[1].sql).toContain('INSERT INTO appointment_assignments');
      expect(calls[1].sql).not.toContain(TENANT_A); // never inlined
      expect(calls[1].params).toEqual([
        assignment.id,
        assignment.tenantId,
        assignment.appointmentId,
        assignment.technicianId,
        assignment.isPrimary,
        assignment.assignedBy,
        assignment.assignedAt,
      ]);

      // Connection always released
      expect(getReleaseCount()).toBe(1);

      // Result mapped from row
      expect(result.id).toBe(assignment.id);
      expect(result.tenantId).toBe(assignment.tenantId);
      expect(result.isPrimary).toBe(true);
    });

    it('PgAssignment release is called even when query throws', async () => {
      const failingClient: Partial<PoolClient> = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [], rowCount: 0 } as unknown as QueryResult)
          .mockRejectedValueOnce(new Error('pg down')),
        release: vi.fn(),
      };
      const pool: Partial<Pool> = {
        connect: vi.fn(async () => failingClient as PoolClient) as unknown as Pool['connect'],
      };

      const repo = new PgAssignmentRepository(pool as Pool);
      await expect(repo.create(makeAssignment())).rejects.toThrow('pg down');
      expect(failingClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('PgAssignment.update', () => {
    it('PgAssignment updates filter by tenant_id (defense-in-depth) and id', async () => {
      const assignment = makeAssignment({ isPrimary: false });
      const { pool, calls } = makeMockPool([undefined, [rowFor(assignment)]]);
      const repo = new PgAssignmentRepository(pool);

      const result = await repo.update(assignment);

      const updateSql = calls[1].sql;
      expect(updateSql).toContain('UPDATE appointment_assignments');
      expect(updateSql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
      expect(updateSql).not.toContain(TENANT_A);

      // params order: [tenantId, id, appointmentId, technicianId, isPrimary, assignedBy, assignedAt]
      expect(calls[1].params[0]).toBe(TENANT_A);
      expect(calls[1].params[1]).toBe('assign-1');
      expect(result.isPrimary).toBe(false);
    });

    it('PgAssignment update throws when no row matches tenant + id', async () => {
      const { pool } = makeMockPool([undefined, []]);
      const repo = new PgAssignmentRepository(pool);
      await expect(repo.update(makeAssignment())).rejects.toThrow(/not found/);
    });
  });

  describe('PgAssignment.findByAppointment', () => {
    it('PgAssignment findByAppointment includes tenant_id in WHERE and is parameterized', async () => {
      const a1 = makeAssignment({ id: 'a1', technicianId: 'tech-1' });
      const a2 = makeAssignment({ id: 'a2', technicianId: 'tech-2', isPrimary: false });
      const { pool, calls } = makeMockPool([undefined, [rowFor(a1), rowFor(a2)]]);
      const repo = new PgAssignmentRepository(pool);

      const results = await repo.findByAppointment(TENANT_A, 'appt-1');

      const sql = calls[1].sql;
      expect(sql).toContain('SELECT * FROM appointment_assignments');
      expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+appointment_id\s*=\s*\$2/);
      expect(sql).not.toContain(TENANT_A);
      expect(calls[1].params).toEqual([TENANT_A, 'appt-1']);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('a1');
      expect(results[1].id).toBe('a2');
    });

    it('PgAssignment findByAppointment returns empty array when no rows match', async () => {
      const { pool } = makeMockPool([undefined, []]);
      const repo = new PgAssignmentRepository(pool);
      const results = await repo.findByAppointment(TENANT_B, 'appt-x');
      expect(results).toEqual([]);
    });
  });

  describe('PgAssignment.findByTechnician', () => {
    it('PgAssignment findByTechnician filters by tenant + technician', async () => {
      const a = makeAssignment();
      const { pool, calls } = makeMockPool([undefined, [rowFor(a)]]);
      const repo = new PgAssignmentRepository(pool);

      const results = await repo.findByTechnician(TENANT_A, 'tech-1');

      const sql = calls[1].sql;
      expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+technician_id\s*=\s*\$2/);
      expect(calls[1].params).toEqual([TENANT_A, 'tech-1']);
      expect(results).toHaveLength(1);
      expect(results[0].technicianId).toBe('tech-1');
    });
  });

  describe('PgAssignment.delete', () => {
    it('PgAssignment delete returns true when a row was removed', async () => {
      const { pool, calls } = makeMockPool([
        undefined,
        // pg returns rowCount on DELETE; our mock derives it from rows.length,
        // so to simulate "1 row deleted" we pass a one-element row array.
        [{ id: 'assign-1' }],
      ]);
      const repo = new PgAssignmentRepository(pool);

      const result = await repo.delete(TENANT_A, 'assign-1');

      const sql = calls[1].sql;
      expect(sql).toContain('DELETE FROM appointment_assignments');
      expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+id\s*=\s*\$2/);
      expect(sql).not.toContain(TENANT_A);
      expect(calls[1].params).toEqual([TENANT_A, 'assign-1']);
      expect(result).toBe(true);
    });

    it('PgAssignment delete returns false when no row matched', async () => {
      const { pool } = makeMockPool([undefined, []]);
      const repo = new PgAssignmentRepository(pool);
      const result = await repo.delete(TENANT_A, 'missing');
      expect(result).toBe(false);
    });
  });

  describe('PgAssignment tenant isolation invariants', () => {
    it('PgAssignment every method sets tenant context before its real query', async () => {
      // For each method, the FIRST query on the connection must be set_config(...).
      const a = makeAssignment();
      const buildPool = () => makeMockPool([
        undefined, // set_config
        [rowFor(a)], // real query
      ]);

      let { pool, calls } = buildPool();
      await new PgAssignmentRepository(pool).create(a);
      expect(calls[0].sql).toContain('app.current_tenant_id');

      ({ pool, calls } = buildPool());
      await new PgAssignmentRepository(pool).update(a);
      expect(calls[0].sql).toContain('app.current_tenant_id');

      ({ pool, calls } = buildPool());
      await new PgAssignmentRepository(pool).findByAppointment(TENANT_A, 'appt-1');
      expect(calls[0].sql).toContain('app.current_tenant_id');

      ({ pool, calls } = buildPool());
      await new PgAssignmentRepository(pool).findByTechnician(TENANT_A, 'tech-1');
      expect(calls[0].sql).toContain('app.current_tenant_id');

      ({ pool, calls } = buildPool());
      await new PgAssignmentRepository(pool).delete(TENANT_A, 'assign-1');
      expect(calls[0].sql).toContain('app.current_tenant_id');
    });

    it('PgAssignment never interpolates tenantId into business-query SQL strings', async () => {
      const a = makeAssignment();
      const { pool, calls } = makeMockPool([undefined, [rowFor(a)]]);
      const repo = new PgAssignmentRepository(pool);

      await repo.findByAppointment(TENANT_A, 'appt-1');
      // Defense check: tenantId only appears in params for business queries.
      // The connection-priming SET app.current_tenant_id statement is exempt
      // because it is not a tenant-scoped data query — it's the channel through
      // which RLS receives the tenant context (and that statement's value is
      // strictly UUID-validated upstream in setTenantContext()).
      const businessQueries = calls.filter((c) => !c.sql.includes('app.current_tenant_id'));
      expect(businessQueries.length).toBeGreaterThan(0);
      for (const c of businessQueries) {
        expect(c.sql).not.toContain(TENANT_A);
      }
    });
  });
});
