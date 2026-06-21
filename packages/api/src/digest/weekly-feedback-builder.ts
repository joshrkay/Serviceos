/**
 * Epic 12.6 — Weekly feedback snapshot builder.
 *
 * Aggregates one tenant's 7-day performance into a WeeklyFeedbackSnapshot,
 * querying the DB directly under tenant RLS (mirrors the daily digest
 * builder's pattern). UTC week windows are passed in pre-computed. Money is
 * integer cents throughout.
 */
import type { Pool } from 'pg';
import { setTenantContext } from '../db/schema';
import type { WeeklyFeedbackSnapshot } from './weekly-feedback';

export async function buildWeeklyFeedbackSnapshot(
  pool: Pool,
  tenantId: string,
  weekStart: Date,
  weekEnd: Date,
): Promise<WeeklyFeedbackSnapshot> {
  const priorStart = new Date(weekStart.getTime() - (weekEnd.getTime() - weekStart.getTime()));
  const client = await pool.connect();
  try {
    await client.query(setTenantContext(tenantId));

    // Revenue: net completed payments received in the window (this + prior).
    // The "received" timestamp column is `paid_at` (the repo maps it to
    // receivedAt) — there is no `received_at` column.
    const revenue = await client.query<{ this_cents: string; prior_cents: string; paid_count: string }>(
      `SELECT
         COALESCE(SUM(amount_cents) FILTER (WHERE paid_at >= $2 AND paid_at < $3), 0)::bigint AS this_cents,
         COALESCE(SUM(amount_cents) FILTER (WHERE paid_at >= $1 AND paid_at < $2), 0)::bigint AS prior_cents,
         COUNT(*) FILTER (WHERE paid_at >= $2 AND paid_at < $3)::int AS paid_count
       FROM payments
       WHERE status = 'completed' AND paid_at >= $1 AND paid_at < $3`,
      [priorStart, weekStart, weekEnd],
    );

    const jobs = await client.query<{ completed: string; prior_completed: string; booked: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'completed' AND updated_at >= $2 AND updated_at < $3)::int AS completed,
         COUNT(*) FILTER (WHERE status = 'completed' AND updated_at >= $1 AND updated_at < $2)::int AS prior_completed,
         COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS booked
       FROM jobs
       WHERE (updated_at >= $1 AND updated_at < $3) OR (created_at >= $2 AND created_at < $3)`,
      [priorStart, weekStart, weekEnd],
    );

    const estimates = await client.query<{ sent_count: string; sent_value: string }>(
      `SELECT
         COUNT(*)::int AS sent_count,
         COALESCE(SUM(total_cents), 0)::bigint AS sent_value
       FROM estimates
       WHERE status = 'sent' AND sent_at >= $1 AND sent_at < $2`,
      [weekStart, weekEnd],
    );

    const calls = await client.query<{ answered: string }>(
      `SELECT COUNT(*)::int AS answered
       FROM voice_sessions
       WHERE channel = 'voice_inbound'
         AND ended_at >= $1 AND ended_at < $2
         AND (outcome IS NULL OR outcome <> 'failed')`,
      [weekStart, weekEnd],
    );

    const leads = await client.query<{ new_leads: string }>(
      `SELECT COUNT(*)::int AS new_leads FROM leads WHERE created_at >= $1 AND created_at < $2`,
      [weekStart, weekEnd],
    );

    // Outstanding is a current snapshot of what's owed, not a windowed sum.
    const outstanding = await client.query<{ outstanding: string }>(
      `SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0)::bigint AS outstanding
       FROM invoices
       WHERE status IN ('open', 'partially_paid')`,
    );

    const num = (v: string | number | undefined): number => Number(v ?? 0);

    return {
      weekStartIso: weekStart.toISOString(),
      weekEndIso: weekEnd.toISOString(),
      revenueCents: num(revenue.rows[0]?.this_cents),
      priorRevenueCents: num(revenue.rows[0]?.prior_cents),
      invoicesPaidCount: num(revenue.rows[0]?.paid_count),
      jobsCompleted: num(jobs.rows[0]?.completed),
      priorJobsCompleted: num(jobs.rows[0]?.prior_completed),
      jobsBooked: num(jobs.rows[0]?.booked),
      estimatesSent: num(estimates.rows[0]?.sent_count),
      estimatesSentValueCents: num(estimates.rows[0]?.sent_value),
      callsAnswered: num(calls.rows[0]?.answered),
      newLeads: num(leads.rows[0]?.new_leads),
      outstandingCents: num(outstanding.rows[0]?.outstanding),
    };
  } finally {
    await client.query('RESET app.current_tenant_id').catch(() => {});
    client.release();
  }
}
