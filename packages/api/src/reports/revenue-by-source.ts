/**
 * Revenue-by-source attribution report.
 *
 * Single grouped query joining `payments → invoices → leads`, scoped to a
 * tenant via RLS. Buckets each completed payment by the originating lead's
 * `(source, utm_source, utm_campaign)` so marketing can answer:
 *   "How much revenue did each campaign generate, and how does conversion
 *    rate compare across channels?"
 *
 * Counts:
 *   - leadCount:     distinct leads in the bucket (any stage)
 *   - customerCount: distinct customers created from those leads
 *   - invoicedCents: SUM(invoice.total_cents) for invoices linked to those leads
 *   - paidCents:     SUM(payments.amount_cents) for completed payments
 *                    on those invoices, restricted to the date window
 *
 * Date window applies to payments only — we want "revenue collected in
 * this period" semantics, not "leads created in this period". Without a
 * window, the totals are all-time.
 *
 * Pre-attribution rows (no originating_lead_id) are bucketed under a
 * sentinel row with source='unknown'. We surface them so users can see
 * how much revenue is unattributed; otherwise the report would silently
 * undercount.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';

export interface RevenueBySourceRow {
  source: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  leadCount: number;
  customerCount: number;
  invoicedCents: number;
  paidCents: number;
}

export interface RevenueBySourceQuery {
  /** Inclusive lower bound on `payments.paid_at` / `payments.created_at`. */
  from?: Date;
  /** Exclusive upper bound. */
  to?: Date;
}

export interface RevenueBySourceRepository {
  query(tenantId: string, q: RevenueBySourceQuery): Promise<RevenueBySourceRow[]>;
}

export class PgRevenueBySourceRepository
  extends PgBaseRepository
  implements RevenueBySourceRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async query(tenantId: string, q: RevenueBySourceQuery): Promise<RevenueBySourceRow[]> {
    return this.withTenant(tenantId, async (client) => {
      const params: unknown[] = [tenantId];
      const dateClauses: string[] = [];
      if (q.from) {
        params.push(q.from);
        dateClauses.push(`p.created_at >= $${params.length}`);
      }
      if (q.to) {
        params.push(q.to);
        dateClauses.push(`p.created_at < $${params.length}`);
      }
      const dateWhere = dateClauses.length > 0 ? `AND ${dateClauses.join(' AND ')}` : '';

      // Pre-aggregate at the invoice level so the lead/customer JOIN can't
      // multiply rows. Without this CTE, joining payments would inflate
      // invoiced_cents (one row per payment) and joining customers (where
      // a converted-from-lead customer exists) would inflate it again.
      // Using SUM(DISTINCT total_cents) was the previous attempt at a
      // workaround but it sums distinct VALUES — two $100 invoices count
      // once. The CTE makes the math correct without DISTINCT tricks.
      const sql = `
        WITH invoice_totals AS (
          SELECT
            i.id,
            i.originating_lead_id,
            i.total_cents,
            COALESCE(
              SUM(p.amount_cents) FILTER (WHERE p.status = 'completed'),
              0
            ) AS paid_cents
          FROM invoices i
          LEFT JOIN payments p
            ON p.invoice_id = i.id ${dateWhere}
          WHERE i.tenant_id = $1
          GROUP BY i.id
        )
        SELECT
          COALESCE(l.source, 'unknown') AS source,
          l.utm_source AS utm_source,
          l.utm_medium AS utm_medium,
          l.utm_campaign AS utm_campaign,
          COUNT(DISTINCT l.id)::int AS lead_count,
          COUNT(DISTINCT c.id)::int AS customer_count,
          COALESCE(SUM(it.total_cents), 0)::bigint AS invoiced_cents,
          COALESCE(SUM(it.paid_cents), 0)::bigint AS paid_cents
        FROM invoice_totals it
        LEFT JOIN leads l ON l.id = it.originating_lead_id
        LEFT JOIN customers c ON c.originating_lead_id = l.id
        GROUP BY COALESCE(l.source, 'unknown'), l.utm_source, l.utm_medium, l.utm_campaign
        HAVING COALESCE(SUM(it.paid_cents), 0) > 0
            OR COALESCE(SUM(it.total_cents), 0) > 0
        ORDER BY paid_cents DESC, invoiced_cents DESC
      `;

      const result = await client.query(sql, params);
      return result.rows.map((row) => ({
        source: row.source as string,
        utmSource: (row.utm_source as string) ?? null,
        utmMedium: (row.utm_medium as string) ?? null,
        utmCampaign: (row.utm_campaign as string) ?? null,
        leadCount: Number(row.lead_count),
        customerCount: Number(row.customer_count),
        invoicedCents: Number(row.invoiced_cents),
        paidCents: Number(row.paid_cents),
      }));
    });
  }
}

/** In-memory implementation used by route-shape tests. */
export class InMemoryRevenueBySourceRepository implements RevenueBySourceRepository {
  private rows: RevenueBySourceRow[] = [];

  setRows(rows: RevenueBySourceRow[]): void {
    this.rows = rows;
  }

  async query(_tenantId: string, _q: RevenueBySourceQuery): Promise<RevenueBySourceRow[]> {
    return this.rows;
  }
}
