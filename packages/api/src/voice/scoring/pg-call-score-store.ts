/**
 * #1736 — Postgres `CallScoreStore` (migrations 338 + 339). Every read and
 * write runs inside `withTenant`, so RLS applies on top of the explicit
 * tenant_id. The eligibility predicate is #1602's, imported unchanged.
 */
import type { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import { ELIGIBLE_FROM_WHERE_SQL } from '../quality/pg-voice-session-grade-store';
import type { CallScore, CallScoreFlag, CallScoreItem } from './call-score';
import type {
  CallCorrection,
  CallScoreStore,
  CatalogPrice,
  CorrectionKind,
  UnscoredWindow,
} from './call-score-store';

interface ScoreRow {
  id: string;
  tenant_id: string;
  session_id: string;
  scored_at: Date;
  score: number;
  rubric_version: string;
  items: CallScoreItem[];
  flags: CallScoreFlag[];
  summary: string;
  model: string;
  cost_micro_cents: string;
  call_ended_at: Date;
}

interface CorrectionRow {
  id: string;
  tenant_id: string;
  session_id: string;
  kind: CorrectionKind;
  turn_index: number | null;
  note: string;
  created_by: string;
  created_at: Date;
  exported_at: Date | null;
  corpus_script_id: string | null;
}

function mapScore(row: ScoreRow): CallScore {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    scoredAt: new Date(row.scored_at),
    score: Number(row.score),
    rubricVersion: row.rubric_version,
    items: row.items,
    flags: row.flags,
    summary: row.summary,
    model: row.model,
    costMicroCents: Number(row.cost_micro_cents),
    callEndedAt: new Date(row.call_ended_at),
  };
}

function mapCorrection(row: CorrectionRow): CallCorrection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    kind: row.kind,
    turnIndex: row.turn_index,
    note: row.note,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    exportedAt: row.exported_at ? new Date(row.exported_at) : null,
    corpusScriptId: row.corpus_script_id,
  };
}

export class PgCallScoreStore extends PgBaseRepository implements CallScoreStore {
  constructor(pool: Pool) {
    super(pool);
  }

  async isEnabled(tenantId: string): Promise<boolean> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{ enabled: boolean }>(
        `SELECT call_scoring_enabled AS enabled FROM tenant_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      return res.rows[0]?.enabled === true;
    });
  }

  async setEnabled(tenantId: string, enabled: boolean): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE tenant_settings SET call_scoring_enabled = $2 WHERE tenant_id = $1`,
        [tenantId, enabled],
      );
    });
  }

  async listCatalogPrices(tenantId: string, limit: number): Promise<CatalogPrice[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{ name: string; unit_price_cents: number }>(
        `SELECT name, unit_price_cents FROM catalog_items
          WHERE tenant_id = $1 AND archived_at IS NULL
          ORDER BY name ASC LIMIT $2`,
        [tenantId, limit],
      );
      return res.rows.map((r) => ({ name: r.name, unitPriceCents: Number(r.unit_price_cents) }));
    });
  }

  async listUnscoredCandidates(tenantId: string, w: UnscoredWindow): Promise<string[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{ id: string }>(
        `SELECT vs.id
           ${ELIGIBLE_FROM_WHERE_SQL}
            AND NOT EXISTS (
              SELECT 1 FROM voice_call_scores s
               WHERE s.tenant_id = vs.tenant_id AND s.session_id = vs.id
            )
          ORDER BY vs.ended_at DESC
          LIMIT $4`,
        [tenantId, w.endedSince, w.endedBefore, w.limit],
      );
      return res.rows.map((r) => r.id);
    });
  }

  async findScore(tenantId: string, sessionId: string): Promise<CallScore | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<ScoreRow>(
        `SELECT * FROM voice_call_scores WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId],
      );
      return res.rows[0] ? mapScore(res.rows[0]) : null;
    });
  }

  async saveScore(score: CallScore): Promise<void> {
    await this.withTenant(score.tenantId, async (client) => {
      await client.query(
        `INSERT INTO voice_call_scores
           (id, tenant_id, session_id, scored_at, score, rubric_version, items, flags,
            summary, model, cost_micro_cents, call_ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
           SET scored_at = EXCLUDED.scored_at,
               score = EXCLUDED.score,
               rubric_version = EXCLUDED.rubric_version,
               items = EXCLUDED.items,
               flags = EXCLUDED.flags,
               summary = EXCLUDED.summary,
               model = EXCLUDED.model,
               cost_micro_cents = EXCLUDED.cost_micro_cents,
               call_ended_at = EXCLUDED.call_ended_at`,
        [
          score.id,
          score.tenantId,
          score.sessionId,
          score.scoredAt,
          score.score,
          score.rubricVersion,
          JSON.stringify(score.items),
          JSON.stringify(score.flags),
          score.summary,
          score.model,
          score.costMicroCents,
          score.callEndedAt,
        ],
      );
    });
  }

  async listScores(tenantId: string, limit: number): Promise<CallScore[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<ScoreRow>(
        `SELECT * FROM voice_call_scores
          WHERE tenant_id = $1
          ORDER BY call_ended_at DESC
          LIMIT $2`,
        [tenantId, limit],
      );
      return res.rows.map(mapScore);
    });
  }

  async saveCorrection(correction: CallCorrection): Promise<CallCorrection> {
    return this.withTenant(correction.tenantId, async (client) => {
      const res = await client.query<CorrectionRow>(
        `INSERT INTO voice_call_corrections
           (id, tenant_id, session_id, kind, turn_index, note, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
           SET kind = EXCLUDED.kind,
               turn_index = EXCLUDED.turn_index,
               note = EXCLUDED.note,
               created_by = EXCLUDED.created_by,
               created_at = EXCLUDED.created_at,
               exported_at = NULL,
               corpus_script_id = NULL
         RETURNING *`,
        [
          correction.id,
          correction.tenantId,
          correction.sessionId,
          correction.kind,
          correction.turnIndex,
          correction.note,
          correction.createdBy,
          correction.createdAt,
        ],
      );
      return mapCorrection(res.rows[0]);
    });
  }

  async findCorrection(tenantId: string, sessionId: string): Promise<CallCorrection | null> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<CorrectionRow>(
        `SELECT * FROM voice_call_corrections WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId],
      );
      return res.rows[0] ? mapCorrection(res.rows[0]) : null;
    });
  }

  async listCorrectionsForSessions(
    tenantId: string,
    sessionIds: readonly string[],
  ): Promise<CallCorrection[]> {
    if (sessionIds.length === 0) return [];
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<CorrectionRow>(
        `SELECT * FROM voice_call_corrections
          WHERE tenant_id = $1 AND session_id = ANY($2::uuid[])`,
        [tenantId, [...sessionIds]],
      );
      return res.rows.map(mapCorrection);
    });
  }

  async listPendingExport(tenantId: string): Promise<CallCorrection[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<CorrectionRow>(
        `SELECT * FROM voice_call_corrections
          WHERE tenant_id = $1 AND exported_at IS NULL
          ORDER BY created_at ASC`,
        [tenantId],
      );
      return res.rows.map(mapCorrection);
    });
  }

  async markExported(tenantId: string, correctionId: string, corpusScriptId: string, at: Date): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE voice_call_corrections
            SET exported_at = $3, corpus_script_id = $4
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, correctionId, at, corpusScriptId],
      );
    });
  }
}
