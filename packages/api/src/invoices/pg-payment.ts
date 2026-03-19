import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { Payment, PaymentRepository, PaymentMethod, PaymentStatus } from './payment';

export class PgPaymentRepository extends PgBaseRepository implements PaymentRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(payment: Payment): Promise<Payment> {
    return this.withTenant(payment.tenantId, async (client) => {
      await client.query(
        `INSERT INTO payments (
          id, tenant_id, invoice_id, amount_cents, status,
          payment_method, reference_number, notes,
          paid_at, created_by, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          payment.id,
          payment.tenantId,
          payment.invoiceId,
          payment.amountCents,
          payment.status,
          payment.method,
          payment.providerReference ?? null,
          payment.note ?? null,
          payment.receivedAt,
          payment.processedBy,
          payment.createdAt,
          payment.updatedAt,
        ],
      );

      return payment;
    });
  }

  async findById(tenantId: string, id: string): Promise<Payment | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM payments WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );

      if (rows.length === 0) return null;
      return this.mapRowToPayment(rows[0]);
    });
  }

  async findByInvoice(tenantId: string, invoiceId: string): Promise<Payment[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM payments WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY created_at DESC`,
        [tenantId, invoiceId],
      );

      return rows.map((row) => this.mapRowToPayment(row));
    });
  }

  async update(tenantId: string, id: string, updates: Partial<Payment>): Promise<Payment | null> {
    return this.withTenant(tenantId, async (client) => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.status !== undefined) {
        setClauses.push(`status = $${paramIndex++}`);
        values.push(updates.status);
      }
      if (updates.amountCents !== undefined) {
        setClauses.push(`amount_cents = $${paramIndex++}`);
        values.push(updates.amountCents);
      }
      if (updates.method !== undefined) {
        setClauses.push(`payment_method = $${paramIndex++}`);
        values.push(updates.method);
      }
      if (updates.providerReference !== undefined) {
        setClauses.push(`reference_number = $${paramIndex++}`);
        values.push(updates.providerReference);
      }
      if (updates.note !== undefined) {
        setClauses.push(`notes = $${paramIndex++}`);
        values.push(updates.note);
      }
      if (updates.receivedAt !== undefined) {
        setClauses.push(`paid_at = $${paramIndex++}`);
        values.push(updates.receivedAt);
      }
      if (updates.updatedAt !== undefined) {
        setClauses.push(`updated_at = $${paramIndex++}`);
        values.push(updates.updatedAt);
      }

      if (setClauses.length === 0) {
        return this.findById(tenantId, id);
      }

      values.push(id, tenantId);
      const { rows } = await client.query(
        `UPDATE payments SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex++} AND tenant_id = $${paramIndex}
         RETURNING *`,
        values,
      );

      if (rows.length === 0) return null;
      return this.mapRowToPayment(rows[0]);
    });
  }

  private mapRowToPayment(row: Record<string, any>): Payment {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      invoiceId: row.invoice_id,
      amountCents: Number(row.amount_cents),
      method: row.payment_method as PaymentMethod,
      status: row.status as PaymentStatus,
      providerReference: row.reference_number ?? undefined,
      note: row.notes ?? undefined,
      receivedAt: new Date(row.paid_at),
      processedBy: row.created_by,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
