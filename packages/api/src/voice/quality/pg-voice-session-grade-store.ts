/**
 * #1602 — Postgres `VoiceSessionGradeStore`.
 *
 * Grades live in `voice_session_grades` (migration 305). The eligibility
 * reads join the EXISTING production tables and encode the two gates the
 * issue asks for:
 *
 *   consent  — `consent_events` has `{ kind: 'recording', state: 'implicit',
 *              source: 'voice', voice_session_id = session }` (the row each
 *              transport commits once the disclosure PLAYED —
 *              `DisclosureResult.commitConsentLedger`) and no
 *              `{ kind: 'recording', state: 'revoked' }` for that session;
 *   billable — `call_usage_events.billable` for `call_id = session id`
 *              (owner / business-phone test calls are `false`, classifyCall).
 *
 * Timing markers for floor #3 come from `call_transcript_turns.started_at`
 * (mid-call persistence, keyed by session_id). Every tenant-scoped read runs
 * inside `withTenant`, so RLS applies on top of the explicit tenant_id.
 */
import type { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import {
  DEFAULT_VOICE_QUALITY_DAILY_CAP,
  DEFAULT_VOICE_QUALITY_SAMPLE_RATE_PCT,
  RECENT_GRADES_LIMIT,
  type GradableVoiceSession,
  type ListCandidatesOptions,
  type VoiceGradeTrigger,
  type VoiceQualityQuota,
  type VoiceQualitySummary,
  type VoiceQualityWindow,
  type VoiceSessionGrade,
  type VoiceSessionGradeCriterion,
  type VoiceSessionGradeStore,
} from './voice-session-grade-store';

/** SQL predicate: the call carried the recording disclosure and never revoked it. */
const DISCLOSED_SQL = `
  EXISTS (
    SELECT 1 FROM consent_events ce
     WHERE ce.tenant_id = vs.tenant_id
       AND ce.voice_session_id = vs.id::text
       AND ce.kind = 'recording' AND ce.state = 'implicit' AND ce.source = 'voice'
  )
  AND NOT EXISTS (
    SELECT 1 FROM consent_events cr
     WHERE cr.tenant_id = vs.tenant_id
       AND cr.voice_session_id = vs.id::text
       AND cr.kind = 'recording' AND cr.state = 'revoked'
  )`;

interface GradeRow {
  id: string;
  tenant_id: string;
  session_id: string;
  graded_at: Date;
  passed: boolean;
  criteria: VoiceSessionGradeCriterion[];
  rubric_version: string;
  model: string;
  judge_calls: number;
  cost_micro_cents: string;
  trigger_kind: VoiceGradeTrigger;
  call_ended_at: Date;
  outcome: string | null;
}

function mapGrade(row: GradeRow): VoiceSessionGrade {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    gradedAt: new Date(row.graded_at),
    passed: row.passed,
    criteria: row.criteria,
    rubricVersion: 'v1',
    model: row.model,
    judgeCalls: Number(row.judge_calls),
    costMicroCents: Number(row.cost_micro_cents),
    trigger: row.trigger_kind,
    callEndedAt: new Date(row.call_ended_at),
    outcome: row.outcome,
  };
}

export class PgVoiceSessionGradeStore extends PgBaseRepository implements VoiceSessionGradeStore {
  constructor(pool: Pool) {
    super(pool);
  }

  async loadSession(tenantId: string, sessionId: string): Promise<GradableVoiceSession | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{
        id: string;
        channel: string;
        started_at: Date;
        ended_at: Date | null;
        outcome: string | null;
        transcript: string[] | null;
        recording_disclosed: boolean;
        billable: boolean | null;
        timezone: string;
      }>(
        `SELECT vs.id, vs.channel, vs.started_at, vs.ended_at, vs.outcome, vs.transcript,
                (${DISCLOSED_SQL}) AS recording_disclosed,
                cue.billable,
                COALESCE(ts.timezone, 'America/New_York') AS timezone
           FROM voice_sessions vs
           LEFT JOIN call_usage_events cue
                  ON cue.tenant_id = vs.tenant_id AND cue.call_id = vs.id::text
           LEFT JOIN tenant_settings ts ON ts.tenant_id = vs.tenant_id
          WHERE vs.tenant_id = $1 AND vs.id = $2`,
        [tenantId, sessionId],
      );
      const row = res.rows[0];
      if (!row) return null;
      const timings = await client.query<{ speaker: 'caller' | 'agent'; started_at: Date }>(
        `SELECT speaker, started_at
           FROM call_transcript_turns
          WHERE tenant_id = $1 AND session_id = $2
          ORDER BY started_at ASC, turn_index ASC`,
        [tenantId, sessionId],
      );
      return {
        id: row.id,
        tenantId,
        channel: row.channel,
        startedAt: new Date(row.started_at),
        endedAt: row.ended_at ? new Date(row.ended_at) : null,
        outcome: row.outcome,
        transcript: Array.isArray(row.transcript) ? row.transcript : [],
        recordingDisclosed: row.recording_disclosed === true,
        billable: row.billable ?? null,
        timezone: row.timezone,
        ...(timings.rows.length > 0
          ? {
              turnTimings: timings.rows.map((t) => ({
                speaker: t.speaker,
                startedAt: new Date(t.started_at),
              })),
            }
          : {}),
      };
    });
  }

  async findGrade(tenantId: string, sessionId: string): Promise<VoiceSessionGrade | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<GradeRow>(
        `SELECT * FROM voice_session_grades WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId],
      );
      return res.rows[0] ? mapGrade(res.rows[0]) : null;
    });
  }

  async listUngradedCandidates(tenantId: string, opts: ListCandidatesOptions): Promise<string[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{ id: string }>(
        `SELECT vs.id
           FROM voice_sessions vs
           JOIN call_usage_events cue
             ON cue.tenant_id = vs.tenant_id AND cue.call_id = vs.id::text AND cue.billable
          WHERE vs.tenant_id = $1
            AND vs.channel = 'voice_inbound'
            AND vs.ended_at IS NOT NULL
            AND vs.ended_at >= $2 AND vs.ended_at < $3
            AND vs.transcript IS NOT NULL
            AND (${DISCLOSED_SQL})
            AND NOT EXISTS (
              SELECT 1 FROM voice_session_grades g
               WHERE g.tenant_id = vs.tenant_id AND g.session_id = vs.id
            )
          ORDER BY vs.ended_at DESC
          LIMIT $4`,
        [tenantId, opts.endedSince, opts.endedBefore, opts.limit],
      );
      return res.rows.map((r) => r.id);
    });
  }

  async countGradedSince(tenantId: string, since: Date): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM voice_session_grades
          WHERE tenant_id = $1 AND graded_at >= $2`,
        [tenantId, since],
      );
      return Number(res.rows[0]?.n ?? 0);
    });
  }

  async quota(tenantId: string): Promise<VoiceQualityQuota> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{ rate: number | null; cap: number | null }>(
        `SELECT voice_quality_sample_rate_pct AS rate, voice_quality_daily_cap AS cap
           FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      const row = res.rows[0];
      return {
        sampleRatePct: row?.rate ?? DEFAULT_VOICE_QUALITY_SAMPLE_RATE_PCT,
        dailyCap: row?.cap ?? DEFAULT_VOICE_QUALITY_DAILY_CAP,
      };
    });
  }

  async saveGrade(grade: VoiceSessionGrade): Promise<void> {
    await this.withTenant(grade.tenantId, async (client) => {
      await client.query(
        `INSERT INTO voice_session_grades
           (id, tenant_id, session_id, graded_at, passed, criteria, rubric_version, model,
            judge_calls, cost_micro_cents, trigger_kind, call_ended_at, outcome)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
           SET graded_at = EXCLUDED.graded_at,
               passed = EXCLUDED.passed,
               criteria = EXCLUDED.criteria,
               rubric_version = EXCLUDED.rubric_version,
               model = EXCLUDED.model,
               judge_calls = EXCLUDED.judge_calls,
               cost_micro_cents = EXCLUDED.cost_micro_cents,
               trigger_kind = EXCLUDED.trigger_kind,
               call_ended_at = EXCLUDED.call_ended_at,
               outcome = EXCLUDED.outcome`,
        [
          grade.id,
          grade.tenantId,
          grade.sessionId,
          grade.gradedAt,
          grade.passed,
          JSON.stringify(grade.criteria),
          grade.rubricVersion,
          grade.model,
          grade.judgeCalls,
          grade.costMicroCents,
          grade.trigger,
          grade.callEndedAt,
          grade.outcome,
        ],
      );
    });
  }

  async summary(tenantId: string, now: Date): Promise<VoiceQualitySummary> {
    return this.withTenant(tenantId, async (client) => {
      const window = async (days: number): Promise<VoiceQualityWindow> => {
        const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        const res = await client.query<{ graded: string; passed: string }>(
          `SELECT COUNT(*)::text AS graded, COUNT(*) FILTER (WHERE passed)::text AS passed
             FROM voice_session_grades
            WHERE tenant_id = $1 AND call_ended_at >= $2 AND call_ended_at <= $3`,
          [tenantId, since, now],
        );
        return { graded: Number(res.rows[0]?.graded ?? 0), passed: Number(res.rows[0]?.passed ?? 0) };
      };
      // Sequential on the one tenant client: pg queues concurrent queries on
      // a single client and deprecates it (removed in pg@9).
      const last7d = await window(7);
      const last30d = await window(30);
      const recent = await recentGrades(client, tenantId);
      return { last7d, last30d, recent };
    });
  }
}

async function recentGrades(client: PoolClient, tenantId: string): Promise<VoiceSessionGrade[]> {
  const res = await client.query<GradeRow>(
    `SELECT * FROM voice_session_grades
      WHERE tenant_id = $1
      ORDER BY graded_at DESC, call_ended_at DESC
      LIMIT $2`,
    [tenantId, RECENT_GRADES_LIMIT],
  );
  return res.rows.map(mapGrade);
}
