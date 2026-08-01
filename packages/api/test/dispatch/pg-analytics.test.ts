import { vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { PgDispatchAnalyticsRepository } from '../../src/dispatch/pg-analytics';
import { DispatchMetric } from '../../src/dispatch/analytics';

type CapturedCall = { sql: string; params: unknown[] };

function makeMockPool(rowsByCallIndex: Array<Record<string, unknown>[] | undefined>) {
  const calls: CapturedCall[] = [];
  let releaseCount = 0;

  const client: Partial<PoolClient> = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      // U2b-2: skip the SET LOCAL transaction framing (BEGIN/COMMIT/ROLLBACK/
      // RESET/SET ROLE) so positional row arrays + calls[0]=context/calls[1]=
      // business assertions are unchanged. Tenant is now a set_config param.
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b)/i.test(sql)) {
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as QueryResult;
      }
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

function makeMetric(overrides: Partial<DispatchMetric> = {}): DispatchMetric {
  return {
    id: 'metric-1',
    tenantId: TENANT_A,
    eventType: 'assigned',
    appointmentId: 'appt-1',
    technicianId: 'tech-1',
    metadata: { source: 'dispatch_board' },
    recordedAt: new Date('2026-04-28T10:00:00.000Z'),
    ...overrides,
  };
}

function rowFor(m: DispatchMetric): Record<string, unknown> {
  return {
    id: m.id,
    tenant_id: m.tenantId,
    event_type: m.eventType,
    appointment_id: m.appointmentId ?? null,
    technician_id: m.technicianId ?? null,
    metadata: m.metadata ?? null,
    recorded_at: m.recordedAt.toISOString(),
  };
}

describe('P0-022 — PgDispatchAnalyticsRepository', () => {
  describe('PgDispatchAnalytics.recordMetric', () => {
    it('PgDispatchAnalytics inserts a metric with parameterized values and sets tenant context', async () => {
      const metric = makeMetric();
      const { pool, calls, getReleaseCount } = makeMockPool([
        undefined, // SET app.current_tenant_id
        [rowFor(metric)], // INSERT ... RETURNING *
      ]);

      const repo = new PgDispatchAnalyticsRepository(pool);
      const result = await repo.recordMetric(metric);

      // First call sets tenant context for RLS.
      expect(calls[0].sql).toContain('app.current_tenant_id');
      expect(calls[0].params).toContain(TENANT_A);

      // Second call is the INSERT — must be parameterized; tenantId never inlined.
      expect(calls[1].sql).toContain('INSERT INTO dispatch_analytics');
      expect(calls[1].sql).not.toContain(TENANT_A);
      expect(calls[1].params).toEqual([
        metric.id,
        metric.tenantId,
        metric.eventType,
        metric.appointmentId,
        metric.technicianId,
        JSON.stringify(metric.metadata),
        metric.recordedAt,
      ]);

      expect(getReleaseCount()).toBe(1);

      expect(result.id).toBe(metric.id);
      expect(result.tenantId).toBe(metric.tenantId);
      expect(result.eventType).toBe('assigned');
      expect(result.metadata).toEqual({ source: 'dispatch_board' });
    });

    it('PgDispatchAnalytics handles optional fields by inserting NULL', async () => {
      const metric = makeMetric({
        appointmentId: undefined,
        technicianId: undefined,
        metadata: undefined,
      });
      const { pool, calls } = makeMockPool([undefined, [rowFor(metric)]]);

      const repo = new PgDispatchAnalyticsRepository(pool);
      await repo.recordMetric(metric);

      expect(calls[1].params[3]).toBeNull(); // appointmentId
      expect(calls[1].params[4]).toBeNull(); // technicianId
      expect(calls[1].params[5]).toBeNull(); // metadata
    });

    it('PgDispatchAnalytics releases the connection even when the insert throws', async () => {
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

      const repo = new PgDispatchAnalyticsRepository(pool as Pool);
      await expect(repo.recordMetric(makeMetric())).rejects.toThrow('pg down');
      expect(failingClient.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('PgDispatchAnalytics.getMetrics', () => {
    it('PgDispatchAnalytics getMetrics without dateRange filters by tenant only', async () => {
      const m = makeMetric();
      const { pool, calls } = makeMockPool([undefined, [rowFor(m)]]);
      const repo = new PgDispatchAnalyticsRepository(pool);

      const results = await repo.getMetrics(TENANT_A);

      const sql = calls[1].sql;
      expect(sql).toContain('SELECT * FROM dispatch_analytics');
      expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/);
      expect(sql).not.toMatch(/recorded_at\s*>=/);
      expect(sql).not.toContain(TENANT_A);
      expect(calls[1].params).toEqual([TENANT_A]);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(m.id);
    });

    it('PgDispatchAnalytics getMetrics with dateRange adds parameterized recorded_at bounds', async () => {
      const m = makeMetric();
      const { pool, calls } = makeMockPool([undefined, [rowFor(m)]]);
      const repo = new PgDispatchAnalyticsRepository(pool);

      const from = new Date('2026-04-01T00:00:00.000Z');
      const to = new Date('2026-04-30T23:59:59.000Z');
      await repo.getMetrics(TENANT_A, { from, to });

      const sql = calls[1].sql;
      expect(sql).toMatch(
        /WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+recorded_at\s*>=\s*\$2\s+AND\s+recorded_at\s*<=\s*\$3/
      );
      expect(calls[1].params).toEqual([TENANT_A, from, to]);
    });

    it('PgDispatchAnalytics getMetrics returns empty array when no rows match', async () => {
      const { pool } = makeMockPool([undefined, []]);
      const repo = new PgDispatchAnalyticsRepository(pool);
      const results = await repo.getMetrics(TENANT_B);
      expect(results).toEqual([]);
    });
  });

  describe('PgDispatchAnalytics.getMetricsByType', () => {
    it('PgDispatchAnalytics getMetricsByType filters by tenant + event_type, parameterized', async () => {
      const m = makeMetric({ eventType: 'delay_notice_sent' });
      const { pool, calls } = makeMockPool([undefined, [rowFor(m)]]);
      const repo = new PgDispatchAnalyticsRepository(pool);

      const results = await repo.getMetricsByType(TENANT_A, 'delay_notice_sent');

      const sql = calls[1].sql;
      expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1\s+AND\s+event_type\s*=\s*\$2/);
      expect(sql).not.toContain(TENANT_A);
      expect(calls[1].params).toEqual([TENANT_A, 'delay_notice_sent']);

      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('delay_notice_sent');
    });
  });

  describe('PgDispatchAnalytics tenant isolation invariants', () => {
    it('PgDispatchAnalytics every method sets tenant context before its real query', async () => {
      const m = makeMetric();
      const buildPool = () => makeMockPool([undefined, [rowFor(m)]]);

      let { pool, calls } = buildPool();
      await new PgDispatchAnalyticsRepository(pool).recordMetric(m);
      expect(calls[0].sql).toContain('app.current_tenant_id');

      ({ pool, calls } = buildPool());
      await new PgDispatchAnalyticsRepository(pool).getMetrics(TENANT_A);
      expect(calls[0].sql).toContain('app.current_tenant_id');

      ({ pool, calls } = buildPool());
      await new PgDispatchAnalyticsRepository(pool).getMetricsByType(TENANT_A, 'assigned');
      expect(calls[0].sql).toContain('app.current_tenant_id');
    });

    it('PgDispatchAnalytics never interpolates tenantId into business-query SQL strings', async () => {
      const m = makeMetric();
      const { pool, calls } = makeMockPool([undefined, [rowFor(m)]]);
      const repo = new PgDispatchAnalyticsRepository(pool);

      await repo.getMetrics(TENANT_A);
      const businessQueries = calls.filter((c) => !c.sql.includes('app.current_tenant_id'));
      expect(businessQueries.length).toBeGreaterThan(0);
      for (const c of businessQueries) {
        expect(c.sql).not.toContain(TENANT_A);
      }
    });
  });
});
