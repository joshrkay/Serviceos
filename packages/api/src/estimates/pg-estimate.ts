import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Estimate, EstimateRepository, EstimateStatus } from './estimate';
import { LineItem, DocumentTotals } from '../shared/billing-engine';

export class PgEstimateRepository extends PgBaseRepository implements EstimateRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(estimate: Estimate): Promise<Estimate> {
    return this.withTenantTransaction(estimate.tenantId, async (client) => {
      await client.query(
        `INSERT INTO estimates (
          id, tenant_id, job_id, estimate_number, status,
          discount_cents, tax_rate_bps, subtotal_cents, taxable_subtotal_cents,
          tax_cents, total_cents, valid_until, customer_message, internal_notes,
          created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          estimate.id,
          estimate.tenantId,
          estimate.jobId,
          estimate.estimateNumber,
          estimate.status,
          estimate.totals.discountCents,
          estimate.totals.taxRateBps,
          estimate.totals.subtotalCents,
          estimate.totals.taxableSubtotalCents,
          estimate.totals.taxCents,
          estimate.totals.totalCents,
          estimate.validUntil ?? null,
          estimate.customerMessage ?? null,
          estimate.internalNotes ?? null,
          estimate.createdBy,
          estimate.createdAt,
          estimate.updatedAt,
        ],
      );

      await this.insertLineItems(client, estimate.tenantId, estimate.id, estimate.lineItems);

      return estimate;
    });
  }

  async findById(tenantId: string, id: string): Promise<Estimate | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM estimates WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );

      if (rows.length === 0) return null;

      const lineItems = await this.fetchLineItems(client, tenantId, id);
      return this.mapRowToEstimate(rows[0], lineItems);
    });
  }

  async findByJob(tenantId: string, jobId: string): Promise<Estimate[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM estimates WHERE tenant_id = $1 AND job_id = $2 ORDER BY created_at DESC`,
        [tenantId, jobId],
      );

      return Promise.all(
        rows.map(async (row) => {
          const lineItems = await this.fetchLineItems(client, tenantId, row.id);
          return this.mapRowToEstimate(row, lineItems);
        }),
      );
    });
  }

  async findByTenant(tenantId: string): Promise<Estimate[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM estimates WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );

      return Promise.all(
        rows.map(async (row) => {
          const lineItems = await this.fetchLineItems(client, tenantId, row.id);
          return this.mapRowToEstimate(row, lineItems);
        }),
      );
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Estimate>): Promise<Estimate | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.status !== undefined) {
        setClauses.push(`status = $${paramIndex++}`);
        values.push(updates.status);
      }
      if (updates.validUntil !== undefined) {
        setClauses.push(`valid_until = $${paramIndex++}`);
        values.push(updates.validUntil);
      }
      if (updates.customerMessage !== undefined) {
        setClauses.push(`customer_message = $${paramIndex++}`);
        values.push(updates.customerMessage);
      }
      if (updates.internalNotes !== undefined) {
        setClauses.push(`internal_notes = $${paramIndex++}`);
        values.push(updates.internalNotes);
      }
      if (updates.totals !== undefined) {
        setClauses.push(`discount_cents = $${paramIndex++}`);
        values.push(updates.totals.discountCents);
        setClauses.push(`tax_rate_bps = $${paramIndex++}`);
        values.push(updates.totals.taxRateBps);
        setClauses.push(`subtotal_cents = $${paramIndex++}`);
        values.push(updates.totals.subtotalCents);
        setClauses.push(`taxable_subtotal_cents = $${paramIndex++}`);
        values.push(updates.totals.taxableSubtotalCents);
        setClauses.push(`tax_cents = $${paramIndex++}`);
        values.push(updates.totals.taxCents);
        setClauses.push(`total_cents = $${paramIndex++}`);
        values.push(updates.totals.totalCents);
      }
      if (updates.updatedAt !== undefined) {
        setClauses.push(`updated_at = $${paramIndex++}`);
        values.push(updates.updatedAt);
      }

      if (setClauses.length > 0) {
        values.push(id, tenantId);
        await client.query(
          `UPDATE estimates SET ${setClauses.join(', ')} WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex}`,
          values,
        );
      }

      if (updates.lineItems !== undefined) {
        await client.query(
          `DELETE FROM estimate_line_items WHERE estimate_id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
        await this.insertLineItems(client, tenantId, id, updates.lineItems);
      }

      return this.findByIdWithClient(client, tenantId, id);
    });
  }

  private async insertLineItems(
    client: PoolClient,
    tenantId: string,
    estimateId: string,
    lineItems: LineItem[],
  ): Promise<void> {
    for (const item of lineItems) {
      await client.query(
        `INSERT INTO estimate_line_items (
          id, tenant_id, estimate_id, description, category,
          quantity, unit_price_cents, total_cents, sort_order, taxable
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          item.id,
          tenantId,
          estimateId,
          item.description,
          item.category ?? 'other',
          item.quantity,
          item.unitPriceCents,
          item.totalCents,
          item.sortOrder,
          item.taxable,
        ],
      );
    }
  }

  private async fetchLineItems(
    client: PoolClient,
    tenantId: string,
    estimateId: string,
  ): Promise<LineItem[]> {
    const { rows } = await client.query(
      `SELECT * FROM estimate_line_items WHERE estimate_id = $1 AND tenant_id = $2 ORDER BY sort_order`,
      [estimateId, tenantId],
    );

    return rows.map((row) => ({
      id: row.id,
      description: row.description,
      category: row.category,
      quantity: Number(row.quantity),
      unitPriceCents: Number(row.unit_price_cents),
      totalCents: Number(row.total_cents),
      sortOrder: Number(row.sort_order),
      taxable: row.taxable,
    }));
  }

  private async findByIdWithClient(
    client: PoolClient,
    tenantId: string,
    id: string,
  ): Promise<Estimate | null> {
    const { rows } = await client.query(
      `SELECT * FROM estimates WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) return null;

    const lineItems = await this.fetchLineItems(client, tenantId, id);
    return this.mapRowToEstimate(rows[0], lineItems);
  }

  private mapRowToEstimate(row: Record<string, any>, lineItems: LineItem[]): Estimate {
    const totals: DocumentTotals = {
      subtotalCents: Number(row.subtotal_cents),
      taxableSubtotalCents: Number(row.taxable_subtotal_cents),
      discountCents: Number(row.discount_cents),
      taxRateBps: Number(row.tax_rate_bps),
      taxCents: Number(row.tax_cents),
      totalCents: Number(row.total_cents),
    };

    return {
      id: row.id,
      tenantId: row.tenant_id,
      jobId: row.job_id,
      estimateNumber: row.estimate_number,
      status: row.status as EstimateStatus,
      lineItems,
      totals,
      validUntil: row.valid_until ? new Date(row.valid_until) : undefined,
      customerMessage: row.customer_message ?? undefined,
      internalNotes: row.internal_notes ?? undefined,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
