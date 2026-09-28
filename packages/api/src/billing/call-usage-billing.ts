import type { Pool } from "pg";
import { recordFunnelEvent } from "../analytics/posthog";
import { randomUUID } from "node:crypto";
import { ValidationError } from "../shared/errors";
import { PgBaseRepository } from "../db/pg-base";
import { OVERAGE_CENTS_PER_MINUTE, priceMinuteUsage, type CallPlanId } from "./call-usage-pricing";
import { formatUsdCentsFixed } from "@ai-service-os/shared";
import type { PgCallUsageRepository } from "./call-usage-events";
import type { OverageCapStore } from "./overage-cap";
import type { Queue, QueueMessage } from "../queues/queue";
import type { Logger } from "../logging/logger";

/**
 * Billing resilience (Part B) — invoice-item POST retry tuning. The create
 * call carries an idempotency key per settlement, so retries are safe.
 * Backoff is full-jitter exponential between the base and cap.
 */
export const OVERAGE_INVOICE_ITEM_MAX_ATTEMPTS = 3;
export const OVERAGE_INVOICE_ITEM_BACKOFF_BASE_MS = 1000;
export const OVERAGE_INVOICE_ITEM_BACKOFF_CAP_MS = 8000;

/** DLQ message type for overage settlements that never got an invoice item. */
export const OVERAGE_SETTLEMENT_DLQ_TYPE = "overage_settlement";

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
  /**
   * Billing resilience (Part B). When wired, a settlement whose invoice-item
   * creation still fails after all retries is written to the shared durable
   * queue's dead-letter table (PgQueue.moveToDeadLetter) so operators can
   * see and re-drive it. Optional so unit harnesses keep building.
   */
  queue?: Queue;
  logger?: Logger;
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

    const customer = await this.deps.pool.query<{
      stripe_customer_id: string | null;
      owner_id: string | null;
    }>(
      `SELECT stripe_customer_id, owner_id FROM tenants WHERE id = $1`,
      [input.tenantId],
    );
    const customerId = customer.rows[0]?.stripe_customer_id;
    if (!customerId) {
      throw new ValidationError("Tenant has no Stripe customer for AI minute overage");
    }
    const invoiceItemId = await this.createInvoiceItemWithRetry({
      tenantId: input.tenantId,
      settlementId: settlement.id,
      customerId,
      overageMinutes: settlement.overageMinutes,
      customerChargeCents: settlement.customerChargeCents,
      stripeInvoiceId: input.stripeInvoiceId,
    });
    await this.deps.settlementRepo.markCompleted(input.tenantId, settlement.id, invoiceItemId);
    recordFunnelEvent({
      distinctId: customer.rows[0]?.owner_id ?? input.tenantId,
      event: 'minute_overage_invoiced',
      properties: {
        tenant_id: input.tenantId,
        plan: planId,
        overage_minutes: settlement.overageMinutes,
        charge_cents: settlement.customerChargeCents,
      },
    });
    return { ...result, invoiceItemId };
  }

  /**
   * Billing resilience (Part B) — reconciliation retry entry point. Re-drives
   * a settlement that is stuck pending/failed (the periodic sweep's repair
   * path). Idempotent: an already-completed settlement is returned as-is, and
   * a zero-charge settlement completes without touching Stripe. Unlike
   * settlePeriod this does NOT pin the item to the originating invoice — by
   * the time the sweep runs that invoice may be finalized, so the item
   * attaches to the next open invoice instead.
   */
  async retrySettlement(input: {
    tenantId: string;
    settlement: CallUsageSettlementRow;
  }): Promise<{ invoiceItemId: string | null; alreadyCompleted: boolean }> {
    const { settlement } = input;
    if (settlement.status === "completed") {
      return { invoiceItemId: settlement.stripeInvoiceItemId, alreadyCompleted: true };
    }
    if (settlement.customerChargeCents === 0) {
      await this.deps.settlementRepo.markCompleted(input.tenantId, settlement.id, null);
      return { invoiceItemId: null, alreadyCompleted: false };
    }
    const customerId = await this.getStripeCustomerId(input.tenantId);
    const invoiceItemId = await this.createInvoiceItemWithRetry({
      tenantId: input.tenantId,
      settlementId: settlement.id,
      customerId,
      overageMinutes: settlement.overageMinutes,
      customerChargeCents: settlement.customerChargeCents,
    });
    await this.deps.settlementRepo.markCompleted(input.tenantId, settlement.id, invoiceItemId);
    return { invoiceItemId, alreadyCompleted: false };
  }

  private async getStripeCustomerId(tenantId: string): Promise<string> {
    const customer = await this.deps.pool.query<{ stripe_customer_id: string | null }>(
      `SELECT stripe_customer_id FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const customerId = customer.rows[0]?.stripe_customer_id;
    if (!customerId) {
      throw new ValidationError("Tenant has no Stripe customer for AI minute overage");
    }
    return customerId;
  }

  /**
   * Billing resilience (Part B) — the invoice-item POST with
   * retry-with-backoff. All attempts share the settlement's idempotency key,
   * so a retry after a transport-level success-but-lost-response cannot
   * double-bill. On persistent failure: the settlement is marked failed, the
   * alert hook fires (app.ts routes it to Sentry), the settlement is written
   * to the durable queue's dead-letter table when a queue is wired, and the
   * error is thrown so the webhook's 500 also triggers Stripe's own retry.
   */
  private async createInvoiceItemWithRetry(input: {
    tenantId: string;
    settlementId: string;
    customerId: string;
    overageMinutes: number;
    customerChargeCents: number;
    stripeInvoiceId?: string;
  }): Promise<string> {
    const body = new URLSearchParams();
    body.set("customer", input.customerId);
    if (input.stripeInvoiceId) body.set("invoice", input.stripeInvoiceId);
    body.set("amount", String(input.customerChargeCents));
    body.set("currency", "usd");
    body.set(
      "description",
      `AI answering minutes over plan: ${input.overageMinutes} at ${formatUsdCentsFixed(OVERAGE_CENTS_PER_MINUTE)}/min`,
    );

    let lastError = "";
    for (let attempt = 1; attempt <= OVERAGE_INVOICE_ITEM_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await (this.deps.fetchFn ?? fetch)(
          "https://api.stripe.com/v1/invoiceitems",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.deps.stripeApiKey}`,
              "Content-Type": "application/x-www-form-urlencoded",
              "Idempotency-Key": `call-overage:${input.settlementId}`,
            },
            body,
          },
        );
        const created = response.ok ? ((await response.json()) as { id?: string }) : {};
        if (created.id) return created.id;
        lastError = response.ok
          ? "Stripe AI minute overage invoice item returned no id"
          : `Stripe AI minute overage invoice item failed (${response.status}): ${await response.text()}`;
      } catch (err) {
        lastError = `Stripe AI minute overage invoice item threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (attempt < OVERAGE_INVOICE_ITEM_MAX_ATTEMPTS) {
        const backoff = Math.min(
          OVERAGE_INVOICE_ITEM_BACKOFF_CAP_MS,
          OVERAGE_INVOICE_ITEM_BACKOFF_BASE_MS * 2 ** (attempt - 1),
        );
        // Full jitter, matching the codebase's backoff idiom.
        await sleep(Math.floor(Math.random() * backoff));
        this.deps.logger?.warn("Overage invoice item attempt failed, retrying", {
          tenantId: input.tenantId,
          settlementId: input.settlementId,
          attempt,
          error: lastError.slice(0, 200),
        });
      }
    }

    await this.deps.settlementRepo.fail(input.tenantId, input.settlementId, lastError);
    await this.deadLetterSettlement(input, lastError).catch(() => undefined);
    void Promise.resolve(
      this.deps.onAlert?.({
        rule: "call_settlement_failed",
        tenantId: input.tenantId,
        message: lastError,
      }),
    ).catch(() => undefined);
    throw new Error(lastError);
  }

  /**
   * Writes a persistently-failed settlement to the durable queue's
   * dead-letter table (the same _queue_dlq the PgQueue depth SLO monitors),
   * so operators can list and re-drive it. No-op when no queue is wired.
   */
  private async deadLetterSettlement(
    input: {
      tenantId: string;
      settlementId: string;
      customerId: string;
      overageMinutes: number;
      customerChargeCents: number;
      stripeInvoiceId?: string;
    },
    error: string,
  ): Promise<void> {
    if (!this.deps.queue) return;
    const message: QueueMessage = {
      id: randomUUID(),
      type: OVERAGE_SETTLEMENT_DLQ_TYPE,
      payload: {
        tenantId: input.tenantId,
        settlementId: input.settlementId,
        customerId: input.customerId,
        overageMinutes: input.overageMinutes,
        customerChargeCents: input.customerChargeCents,
        stripeInvoiceId: input.stripeInvoiceId ?? null,
      },
      attempts: OVERAGE_INVOICE_ITEM_MAX_ATTEMPTS,
      maxAttempts: OVERAGE_INVOICE_ITEM_MAX_ATTEMPTS,
      idempotencyKey: `overage-dlq:${input.settlementId}`,
      createdAt: new Date().toISOString(),
    };
    await this.deps.queue.moveToDeadLetter(message, error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
