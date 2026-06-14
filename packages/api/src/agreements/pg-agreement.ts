/**
 * P9-003 — Pg-backed ServiceAgreement repository.
 *
 * tenant_id is the FIRST predicate in every WHERE clause (defense-in-depth
 * alongside the RLS policy on service_agreements).
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  Agreement,
  AgreementListOptions,
  AgreementRepository,
} from './agreement';
import { AgreementStatus } from './enums';

function mapRow(row: Record<string, unknown>): Agreement {
  const startsOn =
    row.starts_on instanceof Date
      ? row.starts_on.toISOString().slice(0, 10)
      : String(row.starts_on);
  const endsOn = row.ends_on
    ? row.ends_on instanceof Date
      ? row.ends_on.toISOString().slice(0, 10)
      : String(row.ends_on)
    : undefined;
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: row.customer_id as string,
    locationId: (row.location_id as string) ?? undefined,
    name: row.name as string,
    description: (row.description as string) ?? undefined,
    recurrenceRule: row.recurrence_rule as string,
    priceCents: Number(row.price_cents),
    autoGenerateInvoice: row.auto_generate_invoice as boolean,
    autoGenerateJob: row.auto_generate_job as boolean,
    nextRunAt: new Date(row.next_run_at as string),
    lastRunAt: row.last_run_at ? new Date(row.last_run_at as string) : undefined,
    status: row.status as AgreementStatus,
    startsOn,
    endsOn,
    autoRenew: (row.auto_renew as boolean) ?? false,
    renewalTermMonths:
      row.renewal_term_months != null ? Number(row.renewal_term_months) : undefined,
    renewalCount: row.renewal_count != null ? Number(row.renewal_count) : 0,
    memberDiscountBps: row.member_discount_bps != null ? Number(row.member_discount_bps) : 0,
    priorityBooking: (row.priority_booking as boolean) ?? false,
    autoCollectDues: (row.auto_collect_dues as boolean) ?? false,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgAgreementRepository extends PgBaseRepository implements AgreementRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(agreement: Agreement): Promise<Agreement> {
    return this.withTenant(agreement.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO service_agreements (
          id, tenant_id, customer_id, location_id, name, description,
          recurrence_rule, price_cents, auto_generate_invoice, auto_generate_job,
          next_run_at, last_run_at, status, starts_on, ends_on, created_by,
          created_at, updated_at, auto_renew, renewal_term_months, renewal_count,
          member_discount_bps, priority_booking, auto_collect_dues
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
        RETURNING *`,
        [
          agreement.id,
          agreement.tenantId,
          agreement.customerId,
          agreement.locationId ?? null,
          agreement.name,
          agreement.description ?? null,
          agreement.recurrenceRule,
          agreement.priceCents,
          agreement.autoGenerateInvoice,
          agreement.autoGenerateJob,
          agreement.nextRunAt,
          agreement.lastRunAt ?? null,
          agreement.status,
          agreement.startsOn,
          agreement.endsOn ?? null,
          agreement.createdBy,
          agreement.createdAt,
          agreement.updatedAt,
          agreement.autoRenew ?? false,
          agreement.renewalTermMonths ?? null,
          agreement.renewalCount ?? 0,
          agreement.memberDiscountBps ?? 0,
          agreement.priorityBooking ?? false,
          agreement.autoCollectDues ?? false,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Agreement | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM service_agreements WHERE tenant_id = $1 AND id = $2',
        [tenantId, id],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByTenant(tenantId: string, options?: AgreementListOptions): Promise<Agreement[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let i = 2;
      if (options?.customerId) {
        conditions.push(`customer_id = $${i++}`);
        params.push(options.customerId);
      }
      if (options?.status) {
        conditions.push(`status = $${i++}`);
        params.push(options.status);
      }
      let sql = `SELECT * FROM service_agreements WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`;
      if (options?.limit !== undefined) {
        sql += ` LIMIT $${i++}`;
        params.push(options.limit);
      }
      if (options?.offset !== undefined) {
        sql += ` OFFSET $${i++}`;
        params.push(options.offset);
      }
      const result = await client.query(sql, params);
      return result.rows.map(mapRow);
    });
  }

  async findDue(tenantId: string, asOf: Date): Promise<Agreement[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM service_agreements
         WHERE tenant_id = $1
           AND status = 'active'
           AND next_run_at <= $2
           AND (ends_on IS NULL OR ends_on >= $3)
         ORDER BY next_run_at ASC`,
        [tenantId, asOf, asOf.toISOString().slice(0, 10)],
      );
      return result.rows.map(mapRow);
    });
  }

  async findRenewable(tenantId: string, asOf: Date): Promise<Agreement[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM service_agreements
         WHERE tenant_id = $1
           AND status = 'active'
           AND auto_renew = TRUE
           AND ends_on IS NOT NULL
           AND ends_on <= $2
         ORDER BY ends_on ASC`,
        [tenantId, asOf.toISOString().slice(0, 10)],
      );
      return result.rows.map(mapRow);
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Agreement>): Promise<Agreement | null> {
    return this.withTenant(tenantId, async (client) => {
      const fieldMap: Record<string, string> = {
        name: 'name',
        description: 'description',
        recurrenceRule: 'recurrence_rule',
        priceCents: 'price_cents',
        autoGenerateInvoice: 'auto_generate_invoice',
        autoGenerateJob: 'auto_generate_job',
        nextRunAt: 'next_run_at',
        lastRunAt: 'last_run_at',
        status: 'status',
        endsOn: 'ends_on',
        autoRenew: 'auto_renew',
        renewalTermMonths: 'renewal_term_months',
        renewalCount: 'renewal_count',
        memberDiscountBps: 'member_discount_bps',
        priorityBooking: 'priority_booking',
        autoCollectDues: 'auto_collect_dues',
        updatedAt: 'updated_at',
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
        `UPDATE service_agreements SET ${setClauses.join(', ')}
         WHERE tenant_id = $${i++} AND id = $${i++}
         RETURNING *`,
        params,
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
