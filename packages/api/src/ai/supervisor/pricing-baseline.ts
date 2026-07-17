/**
 * N-004 (P2-037) — pricing-anomaly rolling-average baseline (computed inline).
 *
 * No snapshot table (migration 243 skipped): the baseline is an on-the-fly
 * AVG over the tenant's REALIZED prices in a trailing window — accepted
 * estimates + paid invoices `total_cents`. Rejected estimates and void
 * invoices are excluded so the baseline reflects prices customers actually
 * agreed to. Grouping is tenant-wide for v1 (jobs carry no service-category
 * column; the design's resolved-catalog-category grouping is a Wave-3
 * refinement — see feature-supervisor-agent-N004.md §3.3).
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type { PricingBaseline } from './reviewer';

/** Default trailing window for the rolling average (180 days). */
export const PRICING_BASELINE_WINDOW_DAYS = 180;

export interface PricingBaselineResolver {
  resolve(tenantId: string, now?: Date): Promise<PricingBaseline>;
}

export class PgPricingBaselineResolver
  extends PgBaseRepository
  implements PricingBaselineResolver
{
  constructor(pool: Pool) {
    super(pool);
  }

  async resolve(tenantId: string, now: Date = new Date()): Promise<PricingBaseline> {
    const since = new Date(now.getTime() - PRICING_BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{ avg_cents: string | null; sample_size: string }>(
        `SELECT AVG(total_cents) AS avg_cents, COUNT(*) AS sample_size
           FROM (
             SELECT total_cents FROM estimates
               WHERE tenant_id = $1 AND status = 'accepted' AND created_at >= $2
             UNION ALL
             SELECT total_cents FROM invoices
               WHERE tenant_id = $1 AND status = 'paid' AND created_at >= $2
           ) realized`,
        [tenantId, since],
      );
      const row = result.rows[0];
      const sampleSize = Number(row?.sample_size ?? 0);
      const avgCents =
        row?.avg_cents !== null && row?.avg_cents !== undefined
          ? Math.round(Number(row.avg_cents))
          : null;
      return { avgCents, sampleSize };
    });
  }
}
