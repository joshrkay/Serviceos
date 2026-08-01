import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  FinancingApplication,
  FinancingProvider,
  FinancingRepository,
  FinancingStatus,
} from './financing';

/**
 * FIN (Jobber parity) — Postgres-backed financing applications.
 *
 * tenant_id is the first WHERE predicate on every query (defense-in-depth
 * alongside FORCE RLS, migration 225). amount stored as integer cents.
 */
function mapRow(row: Record<string, unknown>): FinancingApplication {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    invoiceId: row.invoice_id as string,
    customerId: (row.customer_id as string | null) ?? null,
    amountCents: Number(row.amount_cents),
    provider: row.provider as FinancingProvider,
    externalId: (row.external_id as string | null) ?? null,
    applicationUrl: (row.application_url as string | null) ?? null,
    status: row.status as FinancingStatus,
    statusReason: (row.status_reason as string | null) ?? null,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgFinancingRepository extends PgBaseRepository implements FinancingRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(application: FinancingApplication): Promise<FinancingApplication> {
    return this.withTenant(application.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO financing_applications (
          id, tenant_id, invoice_id, customer_id, amount_cents, provider,
          external_id, application_url, status, status_reason, created_by,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          application.id,
          application.tenantId,
          application.invoiceId,
          application.customerId,
          application.amountCents,
          application.provider,
          application.externalId,
          application.applicationUrl,
          application.status,
          application.statusReason,
          application.createdBy,
          application.createdAt,
          application.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<FinancingApplication | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM financing_applications WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async listByInvoice(tenantId: string, invoiceId: string): Promise<FinancingApplication[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM financing_applications
         WHERE tenant_id = $1 AND invoice_id = $2
         ORDER BY created_at ASC`,
        [tenantId, invoiceId]
      );
      return result.rows.map(mapRow);
    });
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: FinancingStatus,
    statusReason: string | null
  ): Promise<FinancingApplication | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE financing_applications
         SET status = $3, status_reason = $4, updated_at = NOW()
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, id, status, statusReason]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
