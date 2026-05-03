import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  ProposalExecution,
  ProposalExecutionRepository,
  ProposalExecutionStatus,
  RecordExecutionInput,
} from './proposal-execution';

interface ProposalExecutionRow {
  id: string;
  tenant_id: string;
  proposal_id: string;
  executed_payload: Record<string, unknown>;
  executed_by: string;
  executed_at: Date;
  status: ProposalExecutionStatus;
  error_message: string | null;
  idempotency_key: string | null;
  created_at: Date;
}

function rowToExecution(row: ProposalExecutionRow): ProposalExecution {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    proposalId: row.proposal_id,
    executedPayload: row.executed_payload ?? {},
    executedBy: row.executed_by,
    executedAt: row.executed_at,
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
  };
}

function validateInput(input: RecordExecutionInput): void {
  if (!input.tenantId) throw new Error('proposal_executions: tenantId is required');
  if (!input.proposalId) throw new Error('proposal_executions: proposalId is required');
  if (!input.executedBy) throw new Error('proposal_executions: executedBy is required');
  if (!['succeeded', 'failed', 'undone'].includes(input.status)) {
    throw new Error(`proposal_executions: invalid status ${input.status}`);
  }
  if (input.status === 'failed' && !input.errorMessage) {
    throw new Error('proposal_executions: errorMessage is required when status=failed');
  }
}

export class PgProposalExecutionRepository
  extends PgBaseRepository
  implements ProposalExecutionRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async recordExecution(input: RecordExecutionInput): Promise<ProposalExecution> {
    validateInput(input);
    return this.withTenantTransaction(input.tenantId, async (client) => {
      // When idempotency_key is set, do an upsert that returns the
      // existing row on collision (preserves the original execution
      // instead of overwriting). When it's null, always insert a fresh
      // row — undo + redo both produce new history.
      if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
        const result = await client.query<ProposalExecutionRow>(
          `INSERT INTO proposal_executions (
             tenant_id, proposal_id, executed_payload, executed_by, executed_at,
             status, error_message, idempotency_key
           ) VALUES ($1, $2, $3::jsonb, $4, COALESCE($5, NOW()), $6, $7, $8)
           ON CONFLICT (tenant_id, proposal_id, idempotency_key) DO UPDATE SET
             -- DO UPDATE re-returns the existing row without mutating its
             -- substantive fields. SET to a no-op so RETURNING fires.
             idempotency_key = EXCLUDED.idempotency_key
           RETURNING *`,
          [
            input.tenantId,
            input.proposalId,
            input.executedPayload,
            input.executedBy,
            input.executedAt ?? null,
            input.status,
            input.errorMessage ?? null,
            input.idempotencyKey,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error('proposal_executions: INSERT returned no row');
        return rowToExecution(row);
      }
      const result = await client.query<ProposalExecutionRow>(
        `INSERT INTO proposal_executions (
           tenant_id, proposal_id, executed_payload, executed_by, executed_at,
           status, error_message
         ) VALUES ($1, $2, $3::jsonb, $4, COALESCE($5, NOW()), $6, $7)
         RETURNING *`,
        [
          input.tenantId,
          input.proposalId,
          input.executedPayload,
          input.executedBy,
          input.executedAt ?? null,
          input.status,
          input.errorMessage ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('proposal_executions: INSERT returned no row');
      return rowToExecution(row);
    });
  }

  async findLatestByProposal(
    tenantId: string,
    proposalId: string,
  ): Promise<ProposalExecution | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ProposalExecutionRow>(
        `SELECT *
           FROM proposal_executions
          WHERE proposal_id = $1
          ORDER BY executed_at DESC
          LIMIT 1`,
        [proposalId],
      );
      const row = result.rows[0];
      return row ? rowToExecution(row) : null;
    });
  }

  async listByProposal(
    tenantId: string,
    proposalId: string,
  ): Promise<ProposalExecution[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<ProposalExecutionRow>(
        `SELECT *
           FROM proposal_executions
          WHERE proposal_id = $1
          ORDER BY executed_at DESC`,
        [proposalId],
      );
      return result.rows.map(rowToExecution);
    });
  }
}
