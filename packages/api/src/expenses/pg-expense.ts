import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Expense, ExpenseCategory, ExpenseListOptions, ExpenseRepository } from './expense';

interface ExpenseRow {
  id: string;
  tenant_id: string;
  job_id: string | null;
  description: string;
  amount_cents: string | number;
  category: string;
  vendor: string | null;
  spent_at: Date;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ExpenseRow): Expense {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.job_id ? { jobId: row.job_id } : {}),
    description: row.description,
    amountCents: Number(row.amount_cents),
    category: row.category as ExpenseCategory,
    ...(row.vendor ? { vendor: row.vendor } : {}),
    spentAt: new Date(row.spent_at),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PgExpenseRepository extends PgBaseRepository implements ExpenseRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(expense: Expense): Promise<Expense> {
    return this.withTenantTransaction(expense.tenantId, async (client) => {
      const { rows } = await client.query<ExpenseRow>(
        `INSERT INTO expenses
           (id, tenant_id, job_id, description, amount_cents, category, vendor,
            spent_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          expense.id,
          expense.tenantId,
          expense.jobId ?? null,
          expense.description,
          expense.amountCents,
          expense.category,
          expense.vendor ?? null,
          expense.spentAt,
          expense.createdBy,
          expense.createdAt,
          expense.updatedAt,
        ],
      );
      return mapRow(rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<Expense | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<ExpenseRow>(
        `SELECT * FROM expenses WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return rows.length > 0 ? mapRow(rows[0]) : null;
    });
  }

  async findByTenant(tenantId: string, options?: ExpenseListOptions): Promise<Expense[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (options?.jobId) {
        params.push(options.jobId);
        conditions.push(`job_id = $${params.length}`);
      }
      if (options?.category) {
        params.push(options.category);
        conditions.push(`category = $${params.length}`);
      }
      if (options?.from) {
        params.push(options.from);
        conditions.push(`spent_at >= $${params.length}`);
      }
      if (options?.to) {
        params.push(options.to);
        conditions.push(`spent_at < $${params.length}`);
      }
      const { rows } = await client.query<ExpenseRow>(
        `SELECT * FROM expenses WHERE ${conditions.join(' AND ')} ORDER BY spent_at DESC`,
        params,
      );
      return rows.map(mapRow);
    });
  }
}
