import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  Payment,
  PaymentRepository,
  PaymentListOptions,
  PaymentMethod,
  PaymentStatus,
  IncrementRefundOptions,
  ReversePaymentOptions,
} from './payment';

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
          paid_at, created_by, created_at, updated_at,
          refunded_amount_cents, refunded_at, last_refund_stripe_id,
          reversed_at, reversal_reason
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
          payment.refundedAmountCents ?? 0,
          payment.refundedAt ?? null,
          payment.lastRefundStripeId ?? null,
          payment.reversedAt ?? null,
          payment.reversalReason ?? null,
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

  /**
   * D2-4 (Codex P1 #2 follow-up) — resolve a payment by the value we
   * stamped into `provider_reference` at creation time. Used by the
   * Stripe `charge.refunded` handler to look up the local payment row
   * from the event's `payment_intent` id, since our checkout creation
   * paths attach `tenant_id`/`invoice_id` metadata to the Stripe object
   * but not a `payment_id`.
   *
   * `tenant_id` is included in the WHERE explicitly for defense-in-depth
   * alongside RLS — a misconfigured GUC must not silently leak a payment
   * from another tenant on a colliding reference.
   *
   * Returns the most recently received match (ORDER BY received_at DESC)
   * to defend against an extremely rare duplicate-reference edge case
   * (e.g. a manual replay that re-recorded the same payment_intent
   * before D2-4 made the column unique). Returns `null` when no match.
   */
  async findByProviderReference(
    tenantId: string,
    providerReference: string,
  ): Promise<Payment | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM payments
         WHERE tenant_id = $1 AND reference_number = $2
         ORDER BY paid_at DESC
         LIMIT 1`,
        [tenantId, providerReference],
      );
      if (rows.length === 0) return null;
      return this.mapRowToPayment(rows[0]);
    });
  }

  /**
   * System-level lookup by Stripe payment_intent (the value we stamp into
   * provider_reference at checkout.session.completed). Used by webhook
   * handlers that receive payment events lacking explicit tenant metadata
   * (e.g. charge.refund.updated, whose payload is just the Refund object
   * without the parent charge's metadata.tenant_id).
   *
   * Bypasses tenant-scoped RLS via `withClient` (no `SET app.current_tenant_id`)
   * — only call from server-internal trusted paths. The cross-tenant nature
   * is intentional and is signalled by the explicit method name + the lack
   * of a `tenantId` parameter; the resolved payment's own `tenantId` field
   * is then used to scope all downstream writes (e.g. `recordRefund`).
   */
  async findByProviderReferenceCrossTenant(providerReference: string): Promise<Payment | null> {
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM payments WHERE reference_number = $1 ORDER BY paid_at DESC LIMIT 1`,
        [providerReference],
      );
      if (rows.length === 0) return null;
      return this.mapRowToPayment(rows[0]);
    });
  }

  async findByTenant(
    tenantId: string,
    options?: PaymentListOptions,
  ): Promise<Payment[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (options?.status) {
        params.push(options.status);
        conditions.push(`status = $${params.length}`);
      }
      if (options?.from) {
        params.push(options.from);
        conditions.push(`paid_at >= $${params.length}`);
      }
      if (options?.to) {
        params.push(options.to);
        conditions.push(`paid_at < $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT * FROM payments WHERE ${conditions.join(' AND ')} ORDER BY paid_at DESC`,
        params,
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
      if (updates.refundedAmountCents !== undefined) {
        setClauses.push(`refunded_amount_cents = $${paramIndex++}`);
        values.push(updates.refundedAmountCents);
      }
      if (updates.refundedAt !== undefined) {
        setClauses.push(`refunded_at = $${paramIndex++}`);
        values.push(updates.refundedAt);
      }
      if (updates.lastRefundStripeId !== undefined) {
        setClauses.push(`last_refund_stripe_id = $${paramIndex++}`);
        values.push(updates.lastRefundStripeId);
      }
      if (updates.reversedAt !== undefined) {
        setClauses.push(`reversed_at = $${paramIndex++}`);
        values.push(updates.reversedAt);
      }
      if (updates.reversalReason !== undefined) {
        setClauses.push(`reversal_reason = $${paramIndex++}`);
        values.push(updates.reversalReason);
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

  /**
   * D2-4 — atomic compare-and-swap refund increment. A single UPDATE
   * statement performs the over-refund check inside the WHERE clause,
   * so two concurrent webhook deliveries for the same payment can never
   * both succeed: whichever statement commits second sees the new
   * `refunded_amount_cents` and the predicate fails, returning 0 rows.
   *
   * `tenant_id` is included in the WHERE for defense-in-depth alongside
   * the RLS policy on `payments` — a misconfigured session GUC must not
   * silently fall back to "no rows" without the explicit guard.
   *
   * Returns `null` on 0 rows (either not-found OR would over-refund);
   * the service distinguishes the two via a follow-up `findById`.
   */
  async incrementRefundAtomic(
    tenantId: string,
    id: string,
    opts: IncrementRefundOptions,
  ): Promise<Payment | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE payments
         SET refunded_amount_cents = refunded_amount_cents + $3,
             refunded_at = $4,
             last_refund_stripe_id = COALESCE($5, last_refund_stripe_id),
             updated_at = now()
         WHERE tenant_id = $1
           AND id = $2
           AND refunded_amount_cents + $3 <= amount_cents
         RETURNING *`,
        [tenantId, id, opts.refundCents, opts.refundedAt, opts.stripeRefundId ?? null],
      );
      if (rows.length === 0) return null;
      return this.mapRowToPayment(rows[0]);
    });
  }

  /**
   * Atomic compare-and-swap reversal. A single UPDATE flips the payment
   * to 'failed' only while it is still 'completed' and not yet reversed,
   * so a redelivered NSF/chargeback webhook (or two concurrent
   * deliveries) cannot reverse twice. `tenant_id` is in the WHERE for
   * defense-in-depth alongside RLS. Returns `null` on 0 rows (not found,
   * already reversed, or not 'completed').
   */
  async reversePaymentAtomic(
    tenantId: string,
    id: string,
    opts: ReversePaymentOptions,
  ): Promise<Payment | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE payments
         SET status = 'failed',
             reversed_at = $3,
             reversal_reason = $4,
             updated_at = now()
         WHERE tenant_id = $1
           AND id = $2
           AND status = 'completed'
           AND reversed_at IS NULL
         RETURNING *`,
        [tenantId, id, opts.reversedAt, opts.reason],
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
      // D2-4 — refund tracking columns added in migration 100. Older
      // payment rows written before the migration ran will have the
      // DB default (0/NULL/NULL), so the coalesce + Number() defends
      // against undefined when a stale test fixture is read back.
      refundedAmountCents: row.refunded_amount_cents != null ? Number(row.refunded_amount_cents) : 0,
      refundedAt: row.refunded_at ? new Date(row.refunded_at) : null,
      lastRefundStripeId: row.last_refund_stripe_id ?? null,
      // Reversal columns added in migration 133; older rows default to null.
      reversedAt: row.reversed_at ? new Date(row.reversed_at) : null,
      reversalReason: row.reversal_reason ?? null,
    };
  }
}
