/**
 * N-009 / P2-038 — Postgres-backed correction_lessons repository.
 *
 * Tenant-scoped via RLS (migration 180: tenant_id + FORCE ROW LEVEL
 * SECURITY). All reads/writes go through `withTenant` so the
 * `app.current_tenant_id` GUC filters rows; a mocked Pool is NOT proof the
 * columns exist — the Docker-gated integration test pins the real schema.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type {
  CorrectionLesson,
  CorrectionLessonPayload,
  CorrectionLessonRepository,
  CorrectionLessonStatus,
  CorrectionLessonType,
} from './correction-lesson';

function mapRow(row: Record<string, unknown>): CorrectionLesson {
  const rawPayload = row.payload;
  const payload = (typeof rawPayload === 'string'
    ? JSON.parse(rawPayload)
    : rawPayload) as CorrectionLessonPayload;
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    lessonType: row.lesson_type as CorrectionLessonType,
    status: row.status as CorrectionLessonStatus,
    sourceProposalId: row.source_proposal_id as string,
    ownerId: row.owner_id as string,
    summary: row.summary as string,
    payload,
    localDate:
      row.local_date instanceof Date
        ? toIsoDate(row.local_date)
        : String(row.local_date),
    createdAt: new Date(row.created_at as string),
    revertedAt: row.reverted_at ? new Date(row.reverted_at as string) : null,
  };
}

function toIsoDate(d: Date): string {
  // local_date is a DATE column; normalize to YYYY-MM-DD in UTC to avoid tz drift.
  return d.toISOString().slice(0, 10);
}

export class PgCorrectionLessonRepository
  extends PgBaseRepository
  implements CorrectionLessonRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(lesson: CorrectionLesson): Promise<CorrectionLesson> {
    return this.withTenant(lesson.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO correction_lessons
           (id, tenant_id, lesson_type, status, source_proposal_id, owner_id,
            summary, payload, local_date, created_at, reverted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
         RETURNING *`,
        [
          lesson.id,
          lesson.tenantId,
          lesson.lessonType,
          lesson.status,
          lesson.sourceProposalId,
          lesson.ownerId,
          lesson.summary,
          JSON.stringify(lesson.payload),
          lesson.localDate,
          lesson.createdAt,
          lesson.revertedAt,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<CorrectionLesson | null> {
    return this.withTenant(tenantId, async (client) => {
      // tenant_id is the FIRST predicate (defense-in-depth alongside RLS):
      // test / superuser connections can bypass RLS, so isolation must not
      // depend on the GUC policy alone — matches every other repo here.
      const result = await client.query(
        `SELECT * FROM correction_lessons WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  async findAppliedForDay(tenantId: string, localDate: string): Promise<CorrectionLesson[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM correction_lessons
         WHERE tenant_id = $1 AND status = 'applied' AND local_date = $2
         ORDER BY created_at ASC`,
        [tenantId, localDate],
      );
      return result.rows.map(mapRow);
    });
  }

  async findBySourceProposal(
    tenantId: string,
    sourceProposalId: string,
  ): Promise<CorrectionLesson[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM correction_lessons
         WHERE tenant_id = $1 AND source_proposal_id = $2
         ORDER BY created_at ASC`,
        [tenantId, sourceProposalId],
      );
      return result.rows.map(mapRow);
    });
  }

  async markReverted(
    tenantId: string,
    id: string,
    revertedAt: Date,
  ): Promise<CorrectionLesson | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE correction_lessons
         SET status = 'reverted', reverted_at = $3
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id, revertedAt],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }
}
