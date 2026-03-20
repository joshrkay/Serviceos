import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { EstimateEditDelta, EditDeltaRepository, DeltaEntry } from './edit-delta';

export class PgEditDeltaRepository extends PgBaseRepository implements EditDeltaRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(delta: EstimateEditDelta): Promise<EstimateEditDelta> {
    return this.withTenant(delta.tenantId, async (client) => {
      await client.query(
        `INSERT INTO diff_analyses (
          id, tenant_id, document_type, document_id,
          from_revision_id, to_revision_id, diff, summary,
          status, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          delta.id,
          delta.tenantId,
          'estimate',
          delta.estimateId,
          delta.fromRevisionId,
          delta.toRevisionId,
          JSON.stringify(delta.deltas),
          delta.summary,
          'completed',
          delta.createdAt,
        ],
      );

      return delta;
    });
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<EstimateEditDelta[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM diff_analyses
         WHERE tenant_id = $1 AND document_type = $2 AND document_id = $3
         ORDER BY created_at ASC`,
        [tenantId, 'estimate', estimateId],
      );

      return rows.map((row) => this.mapRowToDelta(row));
    });
  }

  private mapRowToDelta(row: Record<string, any>): EstimateEditDelta {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      estimateId: row.document_id,
      fromRevisionId: row.from_revision_id,
      toRevisionId: row.to_revision_id,
      deltas: (typeof row.diff === 'string' ? JSON.parse(row.diff) : row.diff) as DeltaEntry[],
      summary: row.summary,
      createdAt: new Date(row.created_at),
    };
  }
}
