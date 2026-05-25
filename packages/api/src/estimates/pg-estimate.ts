import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { PgBaseRepository } from '../db/pg-base';
import {
  Estimate,
  EstimateListOptions,
  EstimateListResult,
  EstimateRepository,
  EstimateStatus,
  DEFAULT_ESTIMATE_LIMIT,
  MAX_ESTIMATE_LIMIT,
} from './estimate';
import { LineItem } from '../shared/billing-engine';
import { mapLineItemRow, mapDocumentTotalsRow } from '../shared/document-row-mappers';

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
        `SELECT * FROM estimates WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
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
        `SELECT * FROM estimates WHERE tenant_id = $1 AND job_id = $2 AND deleted_at IS NULL ORDER BY created_at DESC`,
        [tenantId, jobId],
      );

      return this.mapRowsToEstimates(client, tenantId, rows);
    });
  }

  /**
   * Build the parameterized WHERE clause shared between data and count queries.
   * tenant_id is the FIRST predicate (defense-in-depth alongside RLS).
   */
  private buildListWhere(tenantId: string, options?: EstimateListOptions): {
    where: string;
    params: unknown[];
  } {
    const conditions: string[] = ['tenant_id = $1', 'deleted_at IS NULL'];
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

    if (options?.search) {
      const searchParam = `%${options.search}%`;
      conditions.push(
        `(estimate_number ILIKE $${paramIndex} OR customer_message ILIKE $${paramIndex})`
      );
      params.push(searchParam);
      paramIndex++;
    }

    if (options?.sentBefore) {
      conditions.push(`sent_at IS NOT NULL AND sent_at < $${paramIndex}`);
      params.push(options.sentBefore);
      paramIndex++;
    }

    return { where: `WHERE ${conditions.join(' AND ')}`, params };
  }

  async findByTenant(tenantId: string, options?: EstimateListOptions): Promise<Estimate[]> {
    return this.withTenant(tenantId, async (client) => {
      return this.queryListRows(client, tenantId, options);
    });
  }

  private async queryListRows(
    client: PoolClient,
    tenantId: string,
    options?: EstimateListOptions
  ): Promise<Estimate[]> {
    const { where, params } = this.buildListWhere(tenantId, options);
    const sortDirection = options?.sort === 'asc' ? 'ASC' : 'DESC';
    const usePagination = options?.limit !== undefined || options?.offset !== undefined;
    let sql = `SELECT * FROM estimates ${where} ORDER BY created_at ${sortDirection}`;
    let queryParams = params;
    if (usePagination) {
      const limit = Math.min(options?.limit ?? DEFAULT_ESTIMATE_LIMIT, MAX_ESTIMATE_LIMIT);
      const offset = options?.offset ?? 0;
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      queryParams = [...params, limit, offset];
    }
    const { rows } = await client.query(sql, queryParams);
    return this.mapRowsToEstimates(client, tenantId, rows);
  }

  async listWithMeta(
    tenantId: string,
    options?: EstimateListOptions
  ): Promise<EstimateListResult> {
    return this.withTenant(tenantId, async (client) => {
      const limit = Math.min(options?.limit ?? DEFAULT_ESTIMATE_LIMIT, MAX_ESTIMATE_LIMIT);
      const offset = options?.offset ?? 0;
      const data = await this.queryListRows(client, tenantId, { ...options, limit, offset });
      const { where, params } = this.buildListWhere(tenantId, options);
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM estimates ${where}`,
        params
      );
      return { data, total: countResult.rows[0].total as number };
    });
  }

  /**
   * Token-based public lookup. Required for the unauthenticated
   * `/public/estimates/:token` route — at lookup time we don't know
   * which tenant owns this estimate. Mirrors the same pattern used by
   * `PgFeedbackRequestRepository.findByToken`. The query relies on
   * the connection role's RLS configuration; operators must ensure
   * the app role can read rows without a tenant context for
   * token-indexed lookups (typical Supabase / Railway setup).
   *
   * Two-step: (1) global token lookup → tenant_id; (2) re-enter
   * tenant context to load line items via the standard path.
   */
  async findByViewToken(token: string): Promise<Estimate | null> {
    const headerRow = await this.withClient(async (client) => {
      // Use a SECURITY DEFINER function to bypass RLS for the initial token
      // lookup — the token itself is the authentication mechanism, and we have
      // no tenant_id yet to set in the GUC. The function was created as the
      // superuser (see migration) so it runs without RLS filtering.
      const { rows } = await client.query(
        `SELECT id, tenant_id FROM find_estimate_by_view_token($1)`,
        [token],
      );
      return rows[0] ?? null;
    });
    if (!headerRow) return null;
    return this.findById(headerRow.tenant_id, headerRow.id);
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
      if (updates.acceptedAt !== undefined) {
        setClauses.push(`accepted_at = $${paramIndex++}`);
        values.push(updates.acceptedAt);
      }
      if (updates.acceptedByName !== undefined) {
        setClauses.push(`accepted_by_name = $${paramIndex++}`);
        values.push(updates.acceptedByName);
      }
      if (updates.acceptedByIp !== undefined) {
        setClauses.push(`accepted_by_ip = $${paramIndex++}`);
        values.push(updates.acceptedByIp);
      }
      if (updates.acceptedUserAgent !== undefined) {
        setClauses.push(`accepted_user_agent = $${paramIndex++}`);
        values.push(updates.acceptedUserAgent);
      }
      if (updates.acceptedSignatureData !== undefined) {
        setClauses.push(`accepted_signature_data = $${paramIndex++}`);
        values.push(updates.acceptedSignatureData);
      }
      if (updates.rejectedAt !== undefined) {
        setClauses.push(`rejected_at = $${paramIndex++}`);
        values.push(updates.rejectedAt);
      }
      if (updates.rejectedReason !== undefined) {
        setClauses.push(`rejected_reason = $${paramIndex++}`);
        values.push(updates.rejectedReason);
      }
      if (updates.version !== undefined) {
        setClauses.push(`version = $${paramIndex++}`);
        values.push(updates.version);
      }
      if (updates.lastRevisedAt !== undefined) {
        setClauses.push(`last_revised_at = $${paramIndex++}`);
        values.push(updates.lastRevisedAt);
      }
      if (updates.reminderCount !== undefined) {
        setClauses.push(`reminder_count = $${paramIndex++}`);
        values.push(updates.reminderCount);
      }
      if (updates.lastReminderAt !== undefined) {
        setClauses.push(`last_reminder_at = $${paramIndex++}`);
        values.push(updates.lastReminderAt);
      }
      if (updates.acceptedSelection !== undefined) {
        setClauses.push(`accepted_selection = $${paramIndex++}`);
        values.push(JSON.stringify(updates.acceptedSelection));
      }
      if (updates.deletedAt !== undefined) {
        setClauses.push(`deleted_at = $${paramIndex++}`);
        values.push(updates.deletedAt);
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
      // Use a proper UUID for the DB row — client-provided IDs are ephemeral
      // form-field tracking keys and may not be valid UUIDs.
      const rowId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)
        ? item.id
        : uuidv4();
      await client.query(
        `INSERT INTO estimate_line_items (
          id, tenant_id, estimate_id, description, category,
          quantity, unit_price_cents, total_cents, sort_order, taxable,
          group_key, group_label, is_optional, is_default_selected
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          rowId,
          tenantId,
          estimateId,
          item.description,
          item.category ?? 'other',
          item.quantity,
          item.unitPriceCents,
          item.totalCents,
          item.sortOrder,
          item.taxable,
          item.groupKey ?? null,
          item.groupLabel ?? null,
          item.isOptional ?? false,
          item.isDefaultSelected ?? false,
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

    return rows.map((row) => mapLineItemRow(row));
  }

  /**
   * Batch-load line items for many estimates in a single query, grouped by
   * estimate_id. Avoids the N+1 that a per-estimate fetch incurs when mapping
   * a list of estimate rows.
   */
  private async mapRowsToEstimates(
    client: PoolClient,
    tenantId: string,
    rows: Record<string, any>[],
  ): Promise<Estimate[]> {
    if (rows.length === 0) return [];

    const { rows: itemRows } = await client.query(
      `SELECT * FROM estimate_line_items WHERE estimate_id = ANY($1) AND tenant_id = $2 ORDER BY sort_order`,
      [rows.map((r) => r.id), tenantId],
    );

    const byEstimate = new Map<string, LineItem[]>();
    for (const itemRow of itemRows) {
      const list = byEstimate.get(itemRow.estimate_id) ?? [];
      list.push(mapLineItemRow(itemRow));
      byEstimate.set(itemRow.estimate_id, list);
    }

    return rows.map((row) => this.mapRowToEstimate(row, byEstimate.get(row.id) ?? []));
  }

  private async findByIdWithClient(
    client: PoolClient,
    tenantId: string,
    id: string,
  ): Promise<Estimate | null> {
    const { rows } = await client.query(
      `SELECT * FROM estimates WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [id, tenantId],
    );

    if (rows.length === 0) return null;

    const lineItems = await this.fetchLineItems(client, tenantId, id);
    return this.mapRowToEstimate(rows[0], lineItems);
  }

  private mapRowToEstimate(row: Record<string, any>, lineItems: LineItem[]): Estimate {
    const totals = mapDocumentTotalsRow(row);

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
      viewToken: row.view_token ?? undefined,
      viewTokenExpiresAt: row.view_token_expires_at ? new Date(row.view_token_expires_at) : undefined,
      sentAt: row.sent_at ? new Date(row.sent_at) : undefined,
      lastDispatchId: row.last_dispatch_id ?? undefined,
      firstViewedAt: row.first_viewed_at ? new Date(row.first_viewed_at) : undefined,
      viewCount: row.view_count !== undefined && row.view_count !== null ? Number(row.view_count) : undefined,
      acceptedAt: row.accepted_at ? new Date(row.accepted_at) : undefined,
      acceptedByName: row.accepted_by_name ?? undefined,
      acceptedByIp: row.accepted_by_ip ?? undefined,
      acceptedUserAgent: row.accepted_user_agent ?? undefined,
      acceptedSignatureData: row.accepted_signature_data ?? undefined,
      rejectedAt: row.rejected_at ? new Date(row.rejected_at) : undefined,
      rejectedReason: row.rejected_reason ?? undefined,
      version: row.version !== undefined && row.version !== null ? Number(row.version) : 1,
      lastRevisedAt: row.last_revised_at ? new Date(row.last_revised_at) : undefined,
      reminderCount: row.reminder_count !== undefined && row.reminder_count !== null ? Number(row.reminder_count) : 0,
      lastReminderAt: row.last_reminder_at ? new Date(row.last_reminder_at) : undefined,
      acceptedSelection: Array.isArray(row.accepted_selection) ? row.accepted_selection : undefined,
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : undefined,
      createdBy: row.created_by,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
