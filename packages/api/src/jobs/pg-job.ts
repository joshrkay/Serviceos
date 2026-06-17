import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  Job,
  JobFindByCustomerOptions,
  JobListOptions,
  JobListResult,
  JobRepository,
  JobMoneyState,
  DEFAULT_JOB_LIMIT,
  MAX_JOB_LIMIT,
} from './job';

function mapRow(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: row.customer_id as string,
    locationId: row.location_id as string,
    jobNumber: row.job_number as string,
    summary: row.summary as string,
    problemDescription: (row.problem_description as string) ?? undefined,
    status: row.status as Job['status'],
    priority: row.priority as Job['priority'],
    assignedTechnicianId: (row.assigned_technician_id as string) ?? undefined,
    originatingLeadId: (row.originating_lead_id as string) ?? undefined,
    // Tier 4 (Deposit rules — PR 2). Migration 078 columns; default to
    // 0 / 'not_required' for legacy rows via the column DEFAULT.
    depositRequiredCents: (row.deposit_required_cents as number | null) ?? 0,
    depositPaidCents: (row.deposit_paid_cents as number | null) ?? 0,
    depositStatus:
      (row.deposit_status as 'not_required' | 'pending' | 'paid' | null) ?? 'not_required',
    // Tier 4 (Deposit rules — PR 3b). Migration 080 columns. Both
    // nullable in DB; surface as undefined when no link has been minted.
    depositStripePaymentLinkId:
      (row.deposit_stripe_payment_link_id as string | null) ?? undefined,
    depositStripePaymentLinkUrl:
      (row.deposit_stripe_payment_link_url as string | null) ?? undefined,
    // Hennessy — payment-link UX. Migration 138.
    depositStripePaymentLinkExpiresAt: row.deposit_stripe_payment_link_expires_at
      ? new Date(row.deposit_stripe_payment_link_expires_at as string)
      : undefined,
    // Tier 4 (Deposit rules — PR 3c). Migration 081.
    depositCreditedToInvoiceId:
      (row.deposit_credited_to_invoice_id as string | null) ?? undefined,
    // §6 Time-to-Cash. Migration 095; DEFAULT 'no_estimate' for legacy rows.
    moneyState: (row.money_state as JobMoneyState | null) ?? 'no_estimate',
    // Migration 194 — explicit completion + thank-you idempotency stamps.
    // Both nullable; legacy rows backfilled in the migration.
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    thankYouSmsSentAt: row.thank_you_sms_sent_at
      ? new Date(row.thank_you_sms_sent_at as string)
      : undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgJobRepository extends PgBaseRepository implements JobRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(job: Job): Promise<Job> {
    return this.withTenant(job.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO jobs (
          id, tenant_id, customer_id, location_id, job_number, summary,
          problem_description, status, priority, assigned_technician_id,
          originating_lead_id, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *`,
        [
          job.id,
          job.tenantId,
          job.customerId,
          job.locationId,
          job.jobNumber,
          job.summary,
          job.problemDescription ?? null,
          job.status,
          job.priority,
          job.assignedTechnicianId ?? null,
          job.originatingLeadId ?? null,
          job.createdBy,
          job.createdAt,
          job.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Job | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2',
        [tenantId, id]
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  /**
   * Build the parameterized WHERE clause shared by the data and total-count
   * queries. tenant_id is the FIRST predicate (defense-in-depth alongside
   * RLS); all other filters are layered on with parameterized placeholders.
   */
  private buildListWhere(tenantId: string, options?: JobListOptions): {
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

    if (options?.customerId) {
      conditions.push(`customer_id = $${paramIndex}`);
      params.push(options.customerId);
      paramIndex++;
    }

    if (options?.technicianId) {
      conditions.push(`assigned_technician_id = $${paramIndex}`);
      params.push(options.technicianId);
      paramIndex++;
    }

    if (options?.search) {
      const searchParam = `%${options.search}%`;
      conditions.push(
        `(summary ILIKE $${paramIndex} OR job_number ILIKE $${paramIndex})`
      );
      params.push(searchParam);
      paramIndex++;
    }

    return { where: `WHERE ${conditions.join(' AND ')}`, params };
  }

  async findByTenant(tenantId: string, options?: JobListOptions): Promise<Job[]> {
    return this.withTenant(tenantId, async (client) => {
      return this.queryListRows(client, tenantId, options);
    });
  }

  /**
   * P11-001: tenant-scoped read of every job belonging to a customer.
   * Drives the voice lookup-skill family. tenant_id is the FIRST WHERE
   * predicate (defense-in-depth alongside RLS) and customer_id rides as
   * a parameterized placeholder. Default ordering matches `findByTenant`
   * (created_at DESC) so callers see most-recent first.
   */
  async findByCustomer(
    tenantId: string,
    customerId: string,
    opts?: JobFindByCustomerOptions,
  ): Promise<Job[]> {
    return this.withTenant(tenantId, async (client) => {
      const params: unknown[] = [tenantId, customerId];
      let where = 'WHERE tenant_id = $1 AND customer_id = $2';
      if (!opts?.includeArchived) {
        where += " AND status <> 'canceled'";
      }
      const limit = Math.min(opts?.limit ?? MAX_JOB_LIMIT, MAX_JOB_LIMIT);
      params.push(limit);
      const sql = `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`;
      const result = await client.query(sql, params);
      return result.rows.map(mapRow);
    });
  }

  private async queryListRows(
    client: PoolClient,
    tenantId: string,
    options?: JobListOptions
  ): Promise<Job[]> {
    const { where, params } = this.buildListWhere(tenantId, options);
    // P1-018: jobs default to created_at DESC.
    const sortDirection = options?.sort === 'asc' ? 'ASC' : 'DESC';
    const usePagination = options?.limit !== undefined || options?.offset !== undefined;
    let sql = `SELECT * FROM jobs ${where} ORDER BY created_at ${sortDirection}`;
    let queryParams = params;
    if (usePagination) {
      const limit = Math.min(options?.limit ?? DEFAULT_JOB_LIMIT, MAX_JOB_LIMIT);
      const offset = options?.offset ?? 0;
      sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      queryParams = [...params, limit, offset];
    }
    const result = await client.query(sql, queryParams);
    return result.rows.map(mapRow);
  }

  async listWithMeta(tenantId: string, options?: JobListOptions): Promise<JobListResult> {
    return this.withTenant(tenantId, async (client) => {
      const limit = Math.min(options?.limit ?? DEFAULT_JOB_LIMIT, MAX_JOB_LIMIT);
      const offset = options?.offset ?? 0;
      const data = await this.queryListRows(client, tenantId, { ...options, limit, offset });
      const { where, params } = this.buildListWhere(tenantId, options);
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM jobs ${where}`,
        params
      );
      return { data, total: countResult.rows[0].total as number };
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Job>): Promise<Job | null> {
    return this.withTenant(tenantId, async (client) => {
      const fieldMap: Record<string, string> = {
        customerId: 'customer_id',
        locationId: 'location_id',
        jobNumber: 'job_number',
        summary: 'summary',
        problemDescription: 'problem_description',
        status: 'status',
        priority: 'priority',
        assignedTechnicianId: 'assigned_technician_id',
        originatingLeadId: 'originating_lead_id',
        // Tier 4 (Deposit rules — PR 2). Migration 078.
        depositRequiredCents: 'deposit_required_cents',
        depositPaidCents: 'deposit_paid_cents',
        depositStatus: 'deposit_status',
        // Tier 4 (Deposit rules — PR 3b). Migration 080.
        depositStripePaymentLinkId: 'deposit_stripe_payment_link_id',
        depositStripePaymentLinkUrl: 'deposit_stripe_payment_link_url',
        // Hennessy — payment-link UX. Migration 138.
        depositStripePaymentLinkExpiresAt: 'deposit_stripe_payment_link_expires_at',
        // Tier 4 (Deposit rules — PR 3c). Migration 081.
        depositCreditedToInvoiceId: 'deposit_credited_to_invoice_id',
        // §6 Time-to-Cash. Migration 095.
        moneyState: 'money_state',
        // Migration 194 — thank-you SMS columns. completedAt is stamped
        // by transitionJobStatus; thankYouSmsSentAt is stamped by the
        // sweep worker once the SMS has been handled (sent or suppressed).
        completedAt: 'completed_at',
        thankYouSmsSentAt: 'thank_you_sms_sent_at',
        updatedAt: 'updated_at',
      };

      const setClauses: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(updates)) {
        const column = fieldMap[key];
        if (column) {
          setClauses.push(`${column} = $${paramIndex}`);
          params.push(value ?? null);
          paramIndex++;
        }
      }

      if (setClauses.length === 0) return this.findById(tenantId, id);

      params.push(tenantId, id);
      const result = await client.query(
        `UPDATE jobs SET ${setClauses.join(', ')}
         WHERE tenant_id = $${paramIndex} AND id = $${paramIndex + 1}
         RETURNING *`,
        params
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async getNextJobNumber(tenantId: string): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT COUNT(*)::int + 1 AS next_number FROM jobs WHERE tenant_id = $1',
        [tenantId]
      );
      return result.rows[0].next_number as number;
    });
  }

  /**
   * Tier 4 (Deposit rules — PR 3c follow-up). Atomic single-claim of
   * the job's paid deposit, addressing the race flagged on PR 319 (a
   * concurrent invoice-creation could otherwise pass the in-memory
   * "is consumed?" check twice and credit the same deposit twice).
   *
   * Only succeeds when `deposit_credited_to_invoice_id IS NULL` at
   * UPDATE time. Returns the updated row on success, null when the
   * job was already consumed or doesn't exist in the tenant.
   *
   * Tenant scoping: the WHERE includes both id and tenant_id
   * explicitly (defense-in-depth alongside RLS, per the standard
   * called out by the reviewer).
   */
  async atomicallyConsumeDeposit(
    tenantId: string,
    id: string,
    invoiceId: string,
  ): Promise<Job | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE jobs
         SET deposit_credited_to_invoice_id = $1,
             updated_at = NOW()
         WHERE id = $2
           AND tenant_id = $3
           AND deposit_credited_to_invoice_id IS NULL
         RETURNING *`,
        [invoiceId, id, tenantId],
      );
      return result.rows.length > 0
        ? mapRow(result.rows[0] as Record<string, unknown>)
        : null;
    });
  }
}
