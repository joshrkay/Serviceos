/**
 * P21-003 — BatchInvoiceRun dedup ledger.
 *
 * One row per (tenant, job, batch_date). The batch sweep inserts a row before
 * including a job in a `batch_invoice` proposal; a duplicate insert raises a
 * 23505-coded error so a re-run on the same day silently skips jobs already
 * batched — exactly like `service_agreement_runs`. The DB enforces
 * UNIQUE (tenant_id, job_id, batch_date); the in-memory repo mirrors it.
 */
import { v4 as uuidv4 } from 'uuid';

export interface BatchInvoiceRun {
  id: string;
  tenantId: string;
  jobId: string;
  /** Calendar date (YYYY-MM-DD) the batch ran. */
  batchDate: string;
  /** The batch_invoice proposal this job was included in (set once known). */
  proposalId?: string;
  createdAt: Date;
}

export interface BatchInvoiceRunRepository {
  /**
   * Insert a ledger row. Throws an error with `code === '23505'` when a row
   * already exists for (tenantId, jobId, batchDate), so callers treat the
   * race / re-run as "already batched".
   */
  create(run: BatchInvoiceRun): Promise<BatchInvoiceRun>;
  findByJobAndDate(tenantId: string, jobId: string, batchDate: string): Promise<BatchInvoiceRun | null>;
}

export function buildBatchInvoiceRun(
  tenantId: string,
  jobId: string,
  batchDate: string,
  proposalId?: string,
): BatchInvoiceRun {
  return { id: uuidv4(), tenantId, jobId, batchDate, proposalId, createdAt: new Date() };
}

export class InMemoryBatchInvoiceRunRepository implements BatchInvoiceRunRepository {
  private rows: Map<string, BatchInvoiceRun> = new Map();

  async create(run: BatchInvoiceRun): Promise<BatchInvoiceRun> {
    for (const existing of this.rows.values()) {
      if (
        existing.tenantId === run.tenantId &&
        existing.jobId === run.jobId &&
        existing.batchDate === run.batchDate
      ) {
        const err: Error & { code?: string } = new Error(
          `duplicate batch run for job ${run.jobId} on ${run.batchDate}`,
        );
        err.code = '23505';
        throw err;
      }
    }
    this.rows.set(run.id, { ...run });
    return { ...run };
  }

  async findByJobAndDate(
    tenantId: string,
    jobId: string,
    batchDate: string,
  ): Promise<BatchInvoiceRun | null> {
    for (const r of this.rows.values()) {
      if (r.tenantId === tenantId && r.jobId === jobId && r.batchDate === batchDate) {
        return { ...r };
      }
    }
    return null;
  }
}
