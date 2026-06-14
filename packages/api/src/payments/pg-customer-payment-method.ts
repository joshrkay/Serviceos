/**
 * #6 phase 4 — Pg-backed saved payment methods. tenant_id is the first
 * predicate in every WHERE (defense in depth alongside the RLS policy).
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CustomerPaymentMethod,
  CustomerPaymentMethodRepository,
} from './customer-payment-method';

function mapRow(row: Record<string, unknown>): CustomerPaymentMethod {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: row.customer_id as string,
    stripeCustomerId: row.stripe_customer_id as string,
    stripePaymentMethodId: row.stripe_payment_method_id as string,
    brand: (row.brand as string) ?? undefined,
    last4: (row.last4 as string) ?? undefined,
    expMonth: row.exp_month != null ? Number(row.exp_month) : undefined,
    expYear: row.exp_year != null ? Number(row.exp_year) : undefined,
    isDefault: row.is_default as boolean,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PgCustomerPaymentMethodRepository
  extends PgBaseRepository
  implements CustomerPaymentMethodRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(pm: CustomerPaymentMethod): Promise<CustomerPaymentMethod> {
    return this.withTenant(pm.tenantId, async (client) => {
      // ON CONFLICT DO NOTHING makes a concurrent/duplicate save of the same
      // payment method idempotent instead of a UNIQUE-violation 500 — two
      // setup_intent.succeeded deliveries for one card can race the
      // findByStripePaymentMethodId guard.
      const result = await client.query(
        `INSERT INTO customer_payment_methods (
           id, tenant_id, customer_id, stripe_customer_id, stripe_payment_method_id,
           brand, last4, exp_month, exp_year, is_default, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, stripe_payment_method_id) DO NOTHING
         RETURNING *`,
        [
          pm.id,
          pm.tenantId,
          pm.customerId,
          pm.stripeCustomerId,
          pm.stripePaymentMethodId,
          pm.brand ?? null,
          pm.last4 ?? null,
          pm.expMonth ?? null,
          pm.expYear ?? null,
          pm.isDefault,
          pm.createdAt,
          pm.updatedAt,
        ],
      );
      if (result.rows.length > 0) return mapRow(result.rows[0]);
      // Lost the race — the row already exists; return the winner.
      const existing = await client.query(
        `SELECT * FROM customer_payment_methods
         WHERE tenant_id = $1 AND stripe_payment_method_id = $2`,
        [pm.tenantId, pm.stripePaymentMethodId],
      );
      return mapRow(existing.rows[0]);
    });
  }

  async findByCustomer(tenantId: string, customerId: string): Promise<CustomerPaymentMethod[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM customer_payment_methods
         WHERE tenant_id = $1 AND customer_id = $2
         ORDER BY created_at DESC`,
        [tenantId, customerId],
      );
      return result.rows.map(mapRow);
    });
  }

  async findDefaultForCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerPaymentMethod | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM customer_payment_methods
         WHERE tenant_id = $1 AND customer_id = $2 AND is_default = TRUE
         LIMIT 1`,
        [tenantId, customerId],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findByStripePaymentMethodId(
    tenantId: string,
    stripePaymentMethodId: string,
  ): Promise<CustomerPaymentMethod | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM customer_payment_methods
         WHERE tenant_id = $1 AND stripe_payment_method_id = $2
         LIMIT 1`,
        [tenantId, stripePaymentMethodId],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async findStripeCustomerId(tenantId: string, customerId: string): Promise<string | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT stripe_customer_id FROM customer_payment_methods
         WHERE tenant_id = $1 AND customer_id = $2
         LIMIT 1`,
        [tenantId, customerId],
      );
      return result.rows.length > 0 ? (result.rows[0].stripe_customer_id as string) : null;
    });
  }

  async setDefault(tenantId: string, id: string): Promise<CustomerPaymentMethod | null> {
    return this.withTenantTransaction(tenantId, async (client) => {
      const target = await client.query(
        `SELECT customer_id FROM customer_payment_methods WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      if (target.rows.length === 0) return null;
      const customerId = target.rows[0].customer_id as string;
      // One UPDATE flips the target on and every sibling off, atomically.
      await client.query(
        `UPDATE customer_payment_methods
         SET is_default = (id = $3), updated_at = NOW()
         WHERE tenant_id = $1 AND customer_id = $2`,
        [tenantId, customerId, id],
      );
      const updated = await client.query(
        `SELECT * FROM customer_payment_methods WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id],
      );
      return updated.rows.length > 0 ? mapRow(updated.rows[0]) : null;
    });
  }
}
