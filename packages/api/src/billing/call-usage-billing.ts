import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ValidationError } from "../shared/errors";
import { PgBaseRepository } from "../db/pg-base";
import { priceMinuteUsage, type CallPlanId } from "./call-usage-pricing";
import type { PgCallUsageRepository } from "./call-usage-events";
import type { OverageCapStore } from "./overage-cap";

export interface CallUsageSettlementRow {
  id: string;
  status: "pending" | "completed" | "failed";
  billableMinutes: number;
  overageMinutes: number;
  customerChargeCents: number;
  stripeInvoiceItemId: string | null;
}

export interface CallUsageSettlementRepository {
  /**
   * Creates the period's settlement, or returns the existing one unchanged —
   * a retry always re-uses the originally computed charge.
   */
  ensurePending(input: {
    id: string;
    tenantId: string;
    periodStart: Date;
    periodEnd: Date;
    planId: CallPlanId;
    billableSeconds: number;
    billableMinutes: number;
    overageMinutes: number;
    customerChargeCents: number;
  }): Promise<CallUsageSettlementRow>;
  markCompleted(tenantId: string, id: string, stripeInvoiceItemId: string | null): Promise<void>;
  fail(tenantId: string, id: string, error: string): Promise<void>;
}

export class PgCallUsageSettlementRepository
  extends PgBaseRepository
  implements CallUsageSettlementRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async ensurePending(
    input: Parameters<CallUsageSettlementRepository["ensurePending"]>[0],
  ): Promise<CallUsageSettlementRow> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO call_usage_settlements
           (id, tenant_id, period_start, period_end, plan_id, billable_seconds,
            billable_minutes, overage_minutes, customer_charge_cents, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
         ON CONFLICT (tenant_id, period_start, period_end) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [
          input.id,
          input.tenantId,
          input.periodStart,
          input.periodEnd,
          input.planId,
          input.billableSeconds,
          input.billableMinutes,
          input.overageMinutes,
          input.customerChargeCents,
        ],
      );
      const row = result.rows[0];
      return {
        id: row.id as string,
        status: row.status as CallUsageSettlementRow["status"],
        billableMinutes: Number(row.billable_minutes),
        overageMinutes: Number(row.overage_minutes),
        customerChargeCents: Number(row.customer_charge_cents),
        stripeInvoiceItemId: (row.stripe_invoice_item_id as string | null) ?? null,
      };
    });
  }

  async markCompleted(
    tenantId: string,
    id: string,
    stripeInvoiceItemId: string | null,
  ): Promise<void> {
    await this.withTenant(tenantId, (c) =>
      c
        .query(
          `UPDATE call_usage_settlements
              SET status = 'completed', stripe_invoice_item_id = $3,
                  last_error = NULL, updated_at = NOW()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, id, stripeInvoiceItemId],
        )
        .then(() => undefined),
    );
  }

  async fail(tenantId: string, id: string, error: string): Promise<void> {
    await this.withTenant(tenantId, (c) =>
      c
        .query(
          `UPDATE call_usage_settlements
              SET status = 'failed', last_error = $3, updated_at = NOW()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, id, error.slice(0, 500)],
        )
        .then(() => undefined),
    );
  }
}

export interface CallUsageBillingServiceDeps {
  pool: Pool;
  settlementRepo: CallUsageSettlementRepository;
  callUsage: Pick<PgCallUsageRepository, "sumBillableSeconds">;
  overageCaps: OverageCapStore;
  stripeApiKey: string;
  fetchFn?: typeof fetch;
  /** Maps the invoice's subscription price to a plan; null when unknown. */
  planForPriceId: (priceId: string) => CallPlanId | null;
  onAlert?: (alert: CallUsageBillingAlert) => void | Promise<void>;
}

export interface CallUsageBillingAlert {
  rule: "call_settlement_failed";
  tenantId: string;
  message: string;
}

export interface CallUsageSettlement {
  planId: CallPlanId;
  billableMinutes: number;
  overageMinutes: number;
  customerChargeCents: number;
  invoiceItemId: string | null;
}

/** Converts one closed billing period's AI minutes into a Stripe overage item. */
export class CallUsageBillingService {
  constructor(private readonly deps: CallUsageBillingServiceDeps) {}

  async settlePeriod(input: {
    tenantId: string;
    periodStart: Date;
    periodEnd: Date;
    /** Price on the invoice's subscription line: the plan in force now. */
    subscriptionPriceId: string;
    stripeInvoiceId?: string;
  }): Promise<CallUsageSettlement> {
    const planId = this.deps.planForPriceId(input.subscriptionPriceId);
    if (!planId) {
      throw new ValidationError(`Unknown subscription price ${input.subscriptionPriceId}`);
    }
    const billableSeconds = await this.deps.callUsage.sumBillableSeconds(
      input.tenantId,
      input.periodStart,
      input.periodEnd,
    );
    const price = priceMinuteUsage({
      planId,
      billableSeconds,
      overageCapCents: await this.deps.overageCaps.get(input.tenantId),
    });
    const settlement = await this.deps.settlementRepo.ensurePending({
      id: randomUUID(),
      tenantId: input.tenantId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      planId,
      billableSeconds,
      billableMinutes: price.billableMinutes,
      overageMinutes: price.overageMinutes,
      customerChargeCents: price.customerChargeCents,
    });
    const result = {
      planId,
      billableMinutes: settlement.billableMinutes,
      overageMinutes: settlement.overageMinutes,
      customerChargeCents: settlement.customerChargeCents,
    };
    if (settlement.status === "completed") {
      return { ...result, invoiceItemId: settlement.stripeInvoiceItemId };
    }
    if (settlement.customerChargeCents === 0) {
      await this.deps.settlementRepo.markCompleted(input.tenantId, settlement.id, null);
      return { ...result, invoiceItemId: null };
    }

    const customer = await this.deps.pool.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [input.tenantId],
    );
    const customerId = customer.rows[0]?.stripe_customer_id;
    if (!customerId) {
      throw new ValidationError("Tenant has no Stripe customer for AI minute overage");
    }
    const body = new URLSearchParams();
    body.set("customer", customerId);
    if (input.stripeInvoiceId) body.set("invoice", input.stripeInvoiceId);
    body.set("amount", String(settlement.customerChargeCents));
    body.set("currency", "usd");
    body.set("description", `AI answering minutes over plan: ${settlement.overageMinutes} at $1.25/min`);
    const response = await (this.deps.fetchFn ?? fetch)("https://api.stripe.com/v1/invoiceitems", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.deps.stripeApiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `call-overage:${settlement.id}`,
      },
      body,
    });
    const created = response.ok ? ((await response.json()) as { id?: string }) : {};
    if (!created.id) {
      const message = response.ok
        ? "Stripe AI minute overage invoice item returned no id"
        : `Stripe AI minute overage invoice item failed (${response.status}): ${await response.text()}`;
      await this.deps.settlementRepo.fail(input.tenantId, settlement.id, message);
      void Promise.resolve(
        this.deps.onAlert?.({ rule: "call_settlement_failed", tenantId: input.tenantId, message }),
      ).catch(() => undefined);
      throw new Error(message);
    }
    await this.deps.settlementRepo.markCompleted(input.tenantId, settlement.id, created.id);
    return { ...result, invoiceItemId: created.id };
  }
}
