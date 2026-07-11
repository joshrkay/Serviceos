/**
 * WS15 — platform-level (cross-tenant) SLO reads for the slo-monitor worker.
 *
 * `voice_sessions` is tenant-scoped (RLS), and the completion-rate SLO is a
 * PLATFORM aggregate, so this repository uses `withCrossTenantSweep` — the
 * same intentional cross-tenant seam the proposal-execution / recovery /
 * retention sweeps use (named, auditable `rls_cross_tenant` role when
 * RLS_RUNTIME_ROLE is on; falls back to the connection principal otherwise).
 */
import { PgBaseRepository } from '../db/pg-base';

export interface CallOutcomeCounts {
  /** Ended sessions in the window with a terminal outcome stamped. */
  total: number;
  /**
   * "Completed-ish" outcomes: the AI handled the call to a resolution —
   * completed | escalated_to_human | callback_required. The remainder
   * (dropped | no_intent | failed) counts AGAINST the completion rate;
   * `no_intent` (caller hung up without engaging) is a DELIBERATE part of the
   * denominator — an honest completion rate must include callers we lost
   * before intent. Documented in docs/runbooks/slo-alerts.md so a page isn't
   * misread as pure infra failure.
   */
  completedish: number;
}

export class PgPlatformSloRepository extends PgBaseRepository {
  /**
   * Terminal call-outcome counts across ALL tenants for sessions that ended
   * at/after `windowStart`. Sessions with `outcome IS NULL` (still open, or
   * ended before the outcome stamp shipped) are excluded from both counts.
   */
  async endedCallOutcomeCounts(windowStart: Date): Promise<CallOutcomeCounts> {
    return this.withCrossTenantSweep(async (client) => {
      const res = await client.query<{ total: string; completedish: string }>(
        `SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (
             WHERE outcome IN ('completed', 'escalated_to_human', 'callback_required')
           ) AS completedish
         FROM voice_sessions
         WHERE ended_at >= $1
           AND outcome IS NOT NULL`,
        [windowStart],
      );
      return {
        total: Number(res.rows[0]?.total ?? 0),
        completedish: Number(res.rows[0]?.completedish ?? 0),
      };
    });
  }
}
