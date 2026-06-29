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
