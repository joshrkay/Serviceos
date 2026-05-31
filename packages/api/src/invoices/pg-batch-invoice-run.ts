/**
 * P21-003 — Pg-backed batch-invoice-run ledger. The DB
 * UNIQUE (tenant_id, job_id, batch_date) is the source of truth; a losing
 * insert surfaces as code 23505 to the sweep, which treats it as "already
 * batched". Tenant-scoped via PgBaseRepository.withTenant (RLS).
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { BatchInvoiceRun, BatchInvoiceRunRepository } from './batch-invoice-run';

function mapRow(row: Record<string, unknown>): BatchInvoiceRun {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    jobId: row.job_id as string,
    batchDate: row.batch_date as string,
    proposalId: (row.proposal_id as string) ?? undefined,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgBatchInvoiceRunRepository
  extends PgBaseRepository
  implements BatchInvoiceRunRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(run: BatchInvoiceRun): Promise<BatchInvoiceRun> {
    return this.withTenant(run.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO batch_invoice_runs (id, tenant_id, job_id, batch_date, proposal_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [run.id, run.tenantId, run.jobId, run.batchDate, run.proposalId ?? null, run.createdAt],
      );
      return mapRow(result.rows[0]);
    });
  }

  async findByJobAndDate(
    tenantId: string,
    jobId: string,
    batchDate: string,
  ): Promise<BatchInvoiceRun | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM batch_invoice_runs
         WHERE tenant_id = $1 AND job_id = $2 AND batch_date = $3`,
        [tenantId, jobId, batchDate],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
