/**
 * P7-026 PR c — Postgres-backed ServiceCreditRepository.
 *
 * All reads + writes go through `withTenant` which sets
 * `app.current_tenant_id` so the RLS policy on `service_credits`
 * enforces tenant isolation. The rolling 12-month sum is computed
 * via a single aggregate query so the cap check stays cheap.
 */
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CreateServiceCreditInput,
  ServiceCredit,
  ServiceCreditRepository,
} from './service-credit';

interface ServiceCreditRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  amount_cents: string | number;
  review_id: string | null;
  proposal_id: string;
  issued_at: string;
}

interface SumRow {
  sum_cents: string | number | null;
}

function mapRow(row: ServiceCreditRow): ServiceCredit {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    customerId: row.customer_id,
    // amount_cents is a BIGINT and the pg driver returns it as string;
    // coerce defensively for both shapes.
    amountCents: typeof row.amount_cents === 'string'
      ? Number(row.amount_cents)
      : row.amount_cents,
    reviewId: row.review_id,
    proposalId: row.proposal_id,
    issuedAt: new Date(row.issued_at),
  };
}

export class PgServiceCreditRepository
  extends PgBaseRepository
  implements ServiceCreditRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateServiceCreditInput): Promise<ServiceCredit> {
    if (input.amountCents <= 0) {
      throw new Error('amountCents must be positive');
    }
    const id = input.id ?? uuidv4();
    const issuedAt = input.issuedAt ?? new Date();
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query<ServiceCreditRow>(
        `INSERT INTO service_credits (
           id, tenant_id, customer_id, amount_cents,
           review_id, proposal_id, issued_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          id,
          input.tenantId,
          input.customerId,
          input.amountCents,
          input.reviewId,
          input.proposalId,
          issuedAt,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async sumIssuedInLast12Months(
    tenantId: string,
    customerId: string,
  ): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<SumRow>(
        `SELECT COALESCE(SUM(amount_cents), 0) AS sum_cents
         FROM service_credits
         WHERE tenant_id = $1
           AND customer_id = $2
           AND issued_at > NOW() - INTERVAL '12 months'`,
        [tenantId, customerId],
      );
      const raw = result.rows[0]?.sum_cents ?? 0;
      return typeof raw === 'string' ? Number(raw) : raw;
    });
  }
}
