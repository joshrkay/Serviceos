import type { Pool } from 'pg';

export interface TrialUsage {
  /** Inbound minutes recorded today (UTC). */
  dailyMinutes: number;
  /** Inbound minutes accumulated across the entire trial. */
  trialTotalMinutes: number;
  /** Inbound calls currently in flight (ended_at IS NULL). */
  concurrentCalls: number;
}

export async function loadTrialUsage(pool: Pool, tenantId: string): Promise<TrialUsage> {
  const res = await pool.query<{
    daily_minutes: number;
    total_minutes: number;
    concurrent: number;
  }>(
    `SELECT
       COALESCE(SUM(
         CASE WHEN started_at::date = (now() AT TIME ZONE 'UTC')::date
           THEN EXTRACT(EPOCH FROM (ended_at - started_at)) / 60
         END
       ), 0)::int AS daily_minutes,
       COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::int AS total_minutes,
       COUNT(*) FILTER (WHERE ended_at IS NULL)::int AS concurrent
     FROM voice_sessions
     WHERE tenant_id = $1 AND channel = 'voice_inbound'`,
    [tenantId],
  );
  const r = res.rows[0];
  return {
    dailyMinutes: r?.daily_minutes ?? 0,
    trialTotalMinutes: r?.total_minutes ?? 0,
    concurrentCalls: r?.concurrent ?? 0,
  };
}
