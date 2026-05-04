/**
 * P9-003 — Pg-backed AgreementRun repository.
 *
 * The DB UNIQUE (agreement_id, scheduled_for) constraint is the source of
 * truth for idempotency. INSERT failures with code 23505 surface to the
 * service layer, which treats them as "another worker raced us — no-op".
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  AgreementRun,
  AgreementRunRepository,
} from './agreement-run';
import { RunStatus } from './enums';

function mapRow(row: Record<string, unknown>): AgreementRun {
  const scheduledFor =
    row.scheduled_for instanceof Date
      ? row.scheduled_for.toISOString().slice(0, 10)
      : String(row.scheduled_for);
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    agreementId: row.agreement_id as string,
    scheduledFor,
    generatedJobId: (row.generated_job_id as string) ?? undefined,
    generatedInvoiceId: (row.generated_invoice_id as string) ?? undefined,
    status: row.status as RunStatus,
    errorMessage: (row.error_message as string) ?? undefined,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgAgreementRunRepository
  extends PgBaseRepository
  implements AgreementRunRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(run: AgreementRun): Promise<AgreementRun> {
    return this.withTenant(run.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO service_agreement_runs (
          id, tenant_id, agreement_id, scheduled_for, generated_job_id,
          generated_invoice_id, status, error_message, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          run.id,
          run.tenantId,
          run.agreementId,
          run.scheduledFor,
          run.generatedJobId ?? null,
          run.generatedInvoiceId ?? null,
          run.status,
          run.errorMessage ?? null,
          run.createdAt,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<AgreementRun | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM service_agreement_runs WHERE tenant_id = $1 AND id = $2',
        [tenantId, id],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByAgreement(
    tenantId: string,
    agreementId: string,
    limit?: number,
  ): Promise<AgreementRun[]> {
    return this.withTenant(tenantId, async (client) => {
      let sql =
        `SELECT * FROM service_agreement_runs
         WHERE tenant_id = $1 AND agreement_id = $2
         ORDER BY created_at DESC`;
      const params: unknown[] = [tenantId, agreementId];
      if (limit !== undefined) {
        sql += ' LIMIT $3';
        params.push(limit);
      }
      const result = await client.query(sql, params);
      return result.rows.map(mapRow);
    });
  }

  async findByAgreementAndDate(
    tenantId: string,
    agreementId: string,
    scheduledFor: string,
  ): Promise<AgreementRun | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM service_agreement_runs
         WHERE tenant_id = $1 AND agreement_id = $2 AND scheduled_for = $3`,
        [tenantId, agreementId, scheduledFor],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<AgreementRun>,
  ): Promise<AgreementRun | null> {
    return this.withTenant(tenantId, async (client) => {
      const fieldMap: Record<string, string> = {
        generatedJobId: 'generated_job_id',
        generatedInvoiceId: 'generated_invoice_id',
        status: 'status',
        errorMessage: 'error_message',
      };
      const setClauses: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      for (const [key, value] of Object.entries(updates)) {
        const col = fieldMap[key];
        if (col) {
          setClauses.push(`${col} = $${i++}`);
          params.push(value ?? null);
        }
      }
      if (setClauses.length === 0) return this.findById(tenantId, id);
      params.push(tenantId, id);
      const result = await client.query(
        `UPDATE service_agreement_runs SET ${setClauses.join(', ')}
         WHERE tenant_id = $${i++} AND id = $${i++}
         RETURNING *`,
        params,
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
