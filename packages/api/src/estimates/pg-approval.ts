import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { EstimateApproval, ApprovalRepository, ApprovalStatus } from './approval';

export class PgApprovalRepository extends PgBaseRepository implements ApprovalRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(approval: EstimateApproval): Promise<EstimateApproval> {
    return this.withTenant(approval.tenantId, async (client) => {
      await client.query(
        `INSERT INTO estimate_approvals (
          id, tenant_id, estimate_id, status, approved_by, approved_at,
          rejected_by, rejected_at, rejection_reason, approved_with_edits,
          final_revision_id, metadata, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          approval.id,
          approval.tenantId,
          approval.estimateId,
          approval.status,
          approval.approvedBy ?? null,
          approval.approvedAt ?? null,
          approval.rejectedBy ?? null,
          approval.rejectedAt ?? null,
          approval.rejectionReason ?? null,
          approval.approvedWithEdits,
          approval.finalRevisionId ?? null,
          approval.metadata ? JSON.stringify(approval.metadata) : null,
          approval.createdAt,
        ],
      );

      return approval;
    });
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<EstimateApproval | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM estimate_approvals WHERE tenant_id = $1 AND estimate_id = $2`,
        [tenantId, estimateId],
      );

      if (rows.length === 0) return null;
      return this.mapRowToApproval(rows[0]);
    });
  }

  async findByTenant(tenantId: string): Promise<EstimateApproval[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM estimate_approvals WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );

      return rows.map((row) => this.mapRowToApproval(row));
    });
  }

  private mapRowToApproval(row: Record<string, any>): EstimateApproval {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      estimateId: row.estimate_id,
      status: row.status as ApprovalStatus,
      approvedBy: row.approved_by ?? undefined,
      approvedAt: row.approved_at ? new Date(row.approved_at) : undefined,
      rejectedBy: row.rejected_by ?? undefined,
      rejectedAt: row.rejected_at ? new Date(row.rejected_at) : undefined,
      rejectionReason: row.rejection_reason ?? undefined,
      approvedWithEdits: row.approved_with_edits,
      finalRevisionId: row.final_revision_id ?? undefined,
      metadata: row.metadata ?? undefined,
      createdAt: new Date(row.created_at),
    };
  }
}
