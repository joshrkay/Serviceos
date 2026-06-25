import type { Pool } from 'pg';
import { applyTenantContext, clearTenantContext } from '../db/rls-runtime-role';

/**
 * Epic 12.4 — Jobs-booked KPI.
 *
 * "Jobs booked" = jobs created in the period (booking volume), counted with a
 * month-over-month comparison so the owner sees the trend. All statuses count:
 * a booking is a booking even if the job is later canceled — this is intake
 * volume, not secured-work. UTC calendar-month windows (matching the HFCR
 * endpoint's documented bucketing; tenant-tz boundaries are a later
 * refinement, consistent with /api/reports/hfcr).
 *
 * The window + trend math is pure and unit-tested; the reporter runs two
 * RLS-scoped counts (one SQL round-trip) and hands off to the pure summarizer.
 */
export interface JobsBookedSummary {
  month: string;
  bookedThisPeriod: number;
  bookedPriorPeriod: number;
  /** bookedThisPeriod − bookedPriorPeriod. */
  trend: number;
  /** Percent change vs the prior month, or null when there's no baseline. */
  trendPct: number | null;
}

export interface MonthWindows {
  thisStart: Date;
  thisEnd: Date;
  priorStart: Date;
}

/** UTC [start,end) windows for `month` ('YYYY-MM') and the month before it. */
export function monthWindows(month: string): MonthWindows {
  const [year, mon] = month.split('-').map(Number);
  return {
    thisStart: new Date(Date.UTC(year, mon - 1, 1)),
    thisEnd: new Date(Date.UTC(year, mon, 1)),
    priorStart: new Date(Date.UTC(year, mon - 2, 1)),
  };
}

export function summarizeJobsBooked(
  month: string,
  bookedThisPeriod: number,
  bookedPriorPeriod: number,
): JobsBookedSummary {
  const trend = bookedThisPeriod - bookedPriorPeriod;
  const trendPct = bookedPriorPeriod > 0 ? Math.round((trend / bookedPriorPeriod) * 100) : null;
  return { month, bookedThisPeriod, bookedPriorPeriod, trend, trendPct };
}

export interface JobsBookedReporter {
  query(tenantId: string, month: string): Promise<JobsBookedSummary>;
}

/**
 * Counts jobs booked this month vs last month for a tenant. Runs both counts
 * in one query, RLS-scoped via setTenantContext on a dedicated connection
 * (mirrors the digest builder's direct-SQL pattern), so it never depends on
 * the jobs list's 200-row pagination cap.
 */
export class PgJobsBookedReporter implements JobsBookedReporter {
  constructor(private readonly pool: Pool) {}

  async query(tenantId: string, month: string): Promise<JobsBookedSummary> {
    const { thisStart, thisEnd, priorStart } = monthWindows(month);
    const client = await this.pool.connect();
    try {
      await applyTenantContext(client, tenantId);
      const result = await client.query<{ this_count: number; prior_count: number }>(
        `SELECT
           COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS this_count,
           COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS prior_count
         FROM jobs
         WHERE created_at >= $1 AND created_at < $3`,
        [priorStart, thisStart, thisEnd],
      );
      const row = result.rows[0] ?? { this_count: 0, prior_count: 0 };
      return summarizeJobsBooked(month, row.this_count ?? 0, row.prior_count ?? 0);
    } finally {
      await clearTenantContext(client);
      client.release();
    }
  }
}
