import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Invoice, InvoiceRepository, InvoiceStatus } from './invoice';
import { LineItem, DocumentTotals } from '../shared/billing-engine';

export class PgInvoiceRepository extends PgBaseRepository implements InvoiceRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(invoice: Invoice): Promise<Invoice> {
    return this.withTenantTransaction(invoice.tenantId, async (client) => {
      await client.query(
        `INSERT INTO invoices (
          id, tenant_id, job_id, estimate_id, invoice_number, status,
          discount_cents, tax_rate_bps, subtotal_cents, taxable_subtotal_cents,
          tax_cents, total_cents, amount_paid_cents, amount_due_cents,
          issued_at, due_date, customer_message, created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          invoice.id,
          invoice.tenantId,
          invoice.jobId,
          invoice.estimateId ?? null,
          invoice.invoiceNumber,
          invoice.status,
          invoice.totals.discountCents,
          invoice.totals.taxRateBps,
          invoice.totals.subtotalCents,
          invoice.totals.taxableSubtotalCents,
          invoice.totals.taxCents,
          invoice.totals.totalCents,
          invoice.amountPaidCents,
          invoice.amountDueCents,
          invoice.issuedAt ?? null,
          invoice.dueDate ?? null,
          invoice.customerMessage ?? null,
          invoice.createdBy,
          invoice.createdAt,
          invoice.updatedAt,
        ],
      );

      await this.insertLineItems(client, invoice.tenantId, invoice.id, invoice.lineItems);

      return invoice;
    });
  }

  async findById(tenantId: string, id: string): Promise<Invoice | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );

      if (rows.length === 0) return null;

      const lineItems = await this.fetchLineItems(client, tenantId, id);
      return this.mapRowToInvoice(rows[0], lineItems);
    });
  }

  async findByJob(tenantId: string, jobId: string): Promise<Invoice[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM invoices WHERE tenant_id = $1 AND job_id = $2 ORDER BY created_at DESC`,
        [tenantId, jobId],
      );

      return Promise.all(
        rows.map(async (row) => {
          const lineItems = await this.fetchLineItems(client, tenantId, row.id);
          return this.mapRowToInvoice(row, lineItems);
        }),
      );
    });
  }

  async findByTenant(tenantId: string): Promise<Invoice[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );

      return Promise.all(
        rows.map(async (row) => {
          const lineItems = await this.fetchLineItems(client, tenantId, row.id);
          return this.mapRowToInvoice(row, lineItems);
        }),
      );
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Invoice>): Promise<Invoice | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.status !== undefined) {
        setClauses.push(`status = $${paramIndex++}`);
        values.push(updates.status);
      }
      if (updates.amountPaidCents !== undefined) {
        setClauses.push(`amount_paid_cents = $${paramIndex++}`);
        values.push(updates.amountPaidCents);
      }
      if (updates.amountDueCents !== undefined) {
        setClauses.push(`amount_due_cents = $${paramIndex++}`);
        values.push(updates.amountDueCents);
      }
      if (updates.issuedAt !== undefined) {
        setClauses.push(`issued_at = $${paramIndex++}`);
        values.push(updates.issuedAt);
      }
      if (updates.dueDate !== undefined) {
        setClauses.push(`due_date = $${paramIndex++}`);
        values.push(updates.dueDate);
      }
      if (updates.customerMessage !== undefined) {
        setClauses.push(`customer_message = $${paramIndex++}`);
        values.push(updates.customerMessage);
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
          `UPDATE invoices SET ${setClauses.join(', ')} WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex}`,
          values,
        );
      }

      if (updates.lineItems !== undefined) {
        await client.query(
          `DELETE FROM invoice_line_items WHERE invoice_id = $1 AND tenant_id = $2`,
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
    invoiceId: string,
    lineItems: LineItem[],
  ): Promise<void> {
    for (const item of lineItems) {
      await client.query(
        `INSERT INTO invoice_line_items (
          id, tenant_id, invoice_id, description, category,
          quantity, unit_price_cents, total_cents, sort_order, taxable
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          item.id,
          tenantId,
          invoiceId,
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
    invoiceId: string,
  ): Promise<LineItem[]> {
    const { rows } = await client.query(
      `SELECT * FROM invoice_line_items WHERE invoice_id = $1 AND tenant_id = $2 ORDER BY sort_order`,
      [invoiceId, tenantId],
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
  ): Promise<Invoice | null> {
    const { rows } = await client.query(
      `SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );

    if (rows.length === 0) return null;

    const lineItems = await this.fetchLineItems(client, tenantId, id);
    return this.mapRowToInvoice(rows[0], lineItems);
  }

  private mapRowToInvoice(row: Record<string, any>, lineItems: LineItem[]): Invoice {
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
      estimateId: row.estimate_id ?? undefined,
      invoiceNumber: row.invoice_number,
      status: row.status as InvoiceStatus,
      lineItems,
      totals,
      amountPaidCents: Number(row.amount_paid_cents),
      amountDueCents: Number(row.amount_due_cents),
      issuedAt: row.issued_at ? new Date(row.issued_at) : undefined,
      dueDate: row.due_date ? new Date(row.due_date) : undefined,
      customerMessage: row.customer_message ?? undefined,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
