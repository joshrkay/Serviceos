import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PgBaseRepository } from '../db/pg-base';
import {
  Invoice,
  InvoiceListOptions,
  InvoiceListResult,
  InvoiceRepository,
  InvoiceStatus,
  DEFAULT_INVOICE_LIMIT,
  MAX_INVOICE_LIMIT,
} from './invoice';
import { LineItem } from '../shared/billing-engine';
import { mapLineItemRow, mapDocumentTotalsRow } from '../shared/document-row-mappers';

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
          tax_cents, processing_fee_bps, processing_fee_cents, total_cents,
          amount_paid_cents, amount_due_cents,
          issued_at, due_date, customer_message, originating_lead_id,
          schedule_id, milestone_index,
          created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
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
          invoice.totals.processingFeeBps ?? null,
          invoice.totals.processingFeeCents ?? null,
          invoice.totals.totalCents,
          invoice.amountPaidCents,
          invoice.amountDueCents,
          invoice.issuedAt ?? null,
          invoice.dueDate ?? null,
          invoice.customerMessage ?? null,
          invoice.originatingLeadId ?? null,
          invoice.scheduleId ?? null,
          invoice.milestoneIndex ?? null,
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

      return this.mapRowsToInvoices(client, tenantId, rows);
    });
  }

  async findByJobs(tenantId: string, jobIds: string[]): Promise<Invoice[]> {
    if (jobIds.length === 0) return [];
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM invoices WHERE tenant_id = $1 AND job_id = ANY($2) ORDER BY created_at DESC`,
        [tenantId, jobIds],
      );

      return this.mapRowsToInvoices(client, tenantId, rows);
    });
  }

  /**
   * Build the parameterized WHERE clause shared between data and count queries
   * for `findByTenant` / `listWithMeta`. tenant_id is the FIRST predicate as
   * defense-in-depth alongside RLS.
   */
  private buildListWhere(tenantId: string, options?: InvoiceListOptions): {
    where: string;
    params: unknown[];
  } {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let paramIndex = 2;

    if (options?.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(options.status);
      paramIndex++;
    }

    if (options?.jobId) {
      conditions.push(`job_id = $${paramIndex}`);
      params.push(options.jobId);
      paramIndex++;
    }

    if (options?.fromDueDate) {
      conditions.push(`due_date >= $${paramIndex}`);
      params.push(options.fromDueDate);
      paramIndex++;
    }

    if (options?.toDueDate) {
      conditions.push(`due_date <= $${paramIndex}`);
      params.push(options.toDueDate);
      paramIndex++;
    }

    if (options?.search) {
      const searchParam = `%${options.search}%`;
      conditions.push(
        `(invoice_number ILIKE $${paramIndex} OR customer_message ILIKE $${paramIndex})`
      );
      params.push(searchParam);
      paramIndex++;
    }

    return { where: `WHERE ${conditions.join(' AND ')}`, params };
  }

  async findByTenant(tenantId: string, options?: InvoiceListOptions): Promise<Invoice[]> {
    return this.withTenant(tenantId, async (client) => {
      return this.queryListRows(client, tenantId, options);
    });
  }

  private async queryListRows(
    client: PoolClient,
    tenantId: string,
    options?: InvoiceListOptions
  ): Promise<Invoice[]> {
    const { where, params } = this.buildListWhere(tenantId, options);
    const sortDirection = options?.sort === 'asc' ? 'ASC' : 'DESC';
    const usePagination = options?.limit !== undefined || options?.offset !== undefined;
    let sql = `SELECT * FROM invoices ${where} ORDER BY created_at ${sortDirection}`;
    let queryParams = params;
    if (usePagination) {
      const limit = Math.min(options?.limit ?? DEFAULT_INVOICE_LIMIT, MAX_INVOICE_LIMIT);
      const offset = options?.offset ?? 0;
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      queryParams = [...params, limit, offset];
    }
    const { rows } = await client.query(sql, queryParams);
    return this.mapRowsToInvoices(client, tenantId, rows);
  }

  async listWithMeta(
    tenantId: string,
    options?: InvoiceListOptions
  ): Promise<InvoiceListResult> {
    return this.withTenant(tenantId, async (client) => {
      const limit = Math.min(options?.limit ?? DEFAULT_INVOICE_LIMIT, MAX_INVOICE_LIMIT);
      const offset = options?.offset ?? 0;
      const data = await this.queryListRows(client, tenantId, { ...options, limit, offset });
      const { where, params } = this.buildListWhere(tenantId, options);
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM invoices ${where}`,
        params
      );
      return { data, total: countResult.rows[0].total as number };
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
      if (updates.invoiceNumber !== undefined) {
        // Needed for the createInvoiceWithNextNumber flow: insert the row with
        // a PENDING-<uuid> placeholder first, then rewrite to the real
        // sequence number after getNextInvoiceNumber allocates it.
        setClauses.push(`invoice_number = $${paramIndex++}`);
        values.push(updates.invoiceNumber);
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
        setClauses.push(`processing_fee_bps = $${paramIndex++}`);
        values.push(updates.totals.processingFeeBps ?? null);
        setClauses.push(`processing_fee_cents = $${paramIndex++}`);
        values.push(updates.totals.processingFeeCents ?? null);
        setClauses.push(`total_cents = $${paramIndex++}`);
        values.push(updates.totals.totalCents);
      }
      if (updates.updatedAt !== undefined) {
        setClauses.push(`updated_at = $${paramIndex++}`);
        values.push(updates.updatedAt);
      }
      if (updates.viewToken !== undefined) {
        setClauses.push(`view_token = $${paramIndex++}`);
        values.push(updates.viewToken);
      }
      if (updates.sentAt !== undefined) {
        setClauses.push(`sent_at = $${paramIndex++}`);
        values.push(updates.sentAt);
      }
      if (updates.lastDispatchId !== undefined) {
        setClauses.push(`last_dispatch_id = $${paramIndex++}`);
        values.push(updates.lastDispatchId);
      }
      if (updates.viewTokenExpiresAt !== undefined) {
        setClauses.push(`view_token_expires_at = $${paramIndex++}`);
        values.push(updates.viewTokenExpiresAt);
      }
      if (updates.firstViewedAt !== undefined) {
        setClauses.push(`first_viewed_at = $${paramIndex++}`);
        values.push(updates.firstViewedAt);
      }
      if (updates.viewCount !== undefined) {
        setClauses.push(`view_count = $${paramIndex++}`);
        values.push(updates.viewCount);
      }
      if (updates.stripePaymentLinkId !== undefined) {
        setClauses.push(`stripe_payment_link_id = $${paramIndex++}`);
        values.push(updates.stripePaymentLinkId);
      }
      if (updates.stripePaymentLinkUrl !== undefined) {
        setClauses.push(`stripe_payment_link_url = $${paramIndex++}`);
        values.push(updates.stripePaymentLinkUrl);
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

  async incrementAmountPaidAtomic(
    tenantId: string,
    id: string,
    deltaCents: number,
    now: Date,
  ): Promise<Invoice | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      // Single atomic UPDATE: the new paid/due/status are derived from the
      // row's OWN current values, so two concurrent credits both apply (no
      // lost update). GREATEST(0, …) matches the prior JS Math.max(0, …). The
      // status CASE mirrors the old newStatus logic exactly.
      const { rows } = await client.query<{ id: string }>(
        `UPDATE invoices
         SET amount_paid_cents = amount_paid_cents + $3,
             amount_due_cents  = GREATEST(0, total_cents - (amount_paid_cents + $3)),
             status = CASE
               WHEN total_cents - (amount_paid_cents + $3) <= 0 THEN 'paid'
               WHEN amount_paid_cents + $3 > 0 AND status IN ('open', 'partially_paid') THEN 'partially_paid'
               ELSE status
             END,
             updated_at = $4
         WHERE id = $2 AND tenant_id = $1
         RETURNING id`,
        [tenantId, id, deltaCents, now],
      );
      if (rows.length === 0) return null;
      return this.findByIdWithClient(client, tenantId, id);
    });
  }

  async decrementAmountPaidAtomic(
    tenantId: string,
    id: string,
    deltaCents: number,
    now: Date,
  ): Promise<Invoice | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      // Single atomic UPDATE: the new paid/due/status are derived from the
      // row's OWN current values, so a concurrent credit and this reversal both
      // apply (no lost update). GREATEST(0, …) clamps paid at 0, matching the
      // prior JS Math.max(0, …). The status CASE derives the reopened status:
      // 'open' (nothing left paid), 'paid' (still fully covered — e.g. one of
      // several payments reversed), else 'partially_paid'. The WHERE guards to
      // REOPENABLE statuses only, so a void/canceled/draft invoice is left
      // untouched (0 rows → null), exactly as the read-modify-write path skipped
      // it. `total_cents - GREATEST(0, amount_paid_cents - $3)` recomputes the
      // due from the clamped paid, never negative.
      const { rows } = await client.query<{ id: string }>(
        `UPDATE invoices
         SET amount_paid_cents = GREATEST(0, amount_paid_cents - $3),
             amount_due_cents  = GREATEST(0, total_cents - GREATEST(0, amount_paid_cents - $3)),
             status = CASE
               WHEN GREATEST(0, amount_paid_cents - $3) <= 0 THEN 'open'
               WHEN GREATEST(0, amount_paid_cents - $3) >= total_cents THEN 'paid'
               ELSE 'partially_paid'
             END,
             updated_at = $4
         WHERE id = $2 AND tenant_id = $1
           AND status IN ('open', 'partially_paid', 'paid')
         RETURNING id`,
        [tenantId, id, deltaCents, now],
      );
      if (rows.length === 0) return null;
      return this.findByIdWithClient(client, tenantId, id);
    });
  }

  async findByViewToken(token: string): Promise<Invoice | null> {
    const headerRow = await this.withClient(async (client) => {
      // Use a SECURITY DEFINER function to bypass RLS for the initial token
      // lookup — the token itself is the authentication mechanism.
      const { rows } = await client.query(
        `SELECT id, tenant_id FROM find_invoice_by_view_token($1)`,
        [token],
      );
      return rows[0] ?? null;
    });
    if (!headerRow) return null;
    return this.findById(headerRow.tenant_id, headerRow.id);
  }

  async incrementViewCount(tenantId: string, id: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE invoices
         SET view_count = view_count + 1,
             first_viewed_at = COALESCE(first_viewed_at, NOW()),
             updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
    });
  }

  private async insertLineItems(
    client: PoolClient,
    tenantId: string,
    invoiceId: string,
    lineItems: LineItem[],
  ): Promise<void> {
    for (const item of lineItems) {
      // Use a proper UUID for the DB row — client-provided IDs are ephemeral
      // form-field tracking keys and may not be valid UUIDs.
      const rowId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)
        ? item.id
        : uuidv4();
      await client.query(
        `INSERT INTO invoice_line_items (
          id, tenant_id, invoice_id, description, category,
          quantity, unit_price_cents, total_cents, sort_order, taxable
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          rowId,
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

    return rows.map((row) => mapLineItemRow(row));
  }

  /**
   * Batch-load line items for many invoices in a single query, grouped by
   * invoice_id. Avoids the N+1 that a per-invoice fetch incurs when mapping
   * a list of invoice rows.
   */
  private async mapRowsToInvoices(
    client: PoolClient,
    tenantId: string,
    rows: Record<string, any>[],
  ): Promise<Invoice[]> {
    if (rows.length === 0) return [];

    const { rows: itemRows } = await client.query(
      `SELECT * FROM invoice_line_items WHERE invoice_id = ANY($1) AND tenant_id = $2 ORDER BY sort_order`,
      [rows.map((r) => r.id), tenantId],
    );

    const byInvoice = new Map<string, LineItem[]>();
    for (const itemRow of itemRows) {
      const list = byInvoice.get(itemRow.invoice_id) ?? [];
      list.push(mapLineItemRow(itemRow));
      byInvoice.set(itemRow.invoice_id, list);
    }

    return rows.map((row) => this.mapRowToInvoice(row, byInvoice.get(row.id) ?? []));
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
    const totals = mapDocumentTotalsRow(row);

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
      viewToken: row.view_token ?? undefined,
      viewTokenExpiresAt: row.view_token_expires_at ? new Date(row.view_token_expires_at) : undefined,
      sentAt: row.sent_at ? new Date(row.sent_at) : undefined,
      lastDispatchId: row.last_dispatch_id ?? undefined,
      firstViewedAt: row.first_viewed_at ? new Date(row.first_viewed_at) : undefined,
      viewCount: row.view_count !== undefined && row.view_count !== null ? Number(row.view_count) : undefined,
      stripePaymentLinkId: row.stripe_payment_link_id ?? undefined,
      stripePaymentLinkUrl: row.stripe_payment_link_url ?? undefined,
      originatingLeadId: row.originating_lead_id ?? undefined,
      scheduleId: row.schedule_id ?? undefined,
      milestoneIndex:
        row.milestone_index !== undefined && row.milestone_index !== null
          ? Number(row.milestone_index)
          : undefined,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
