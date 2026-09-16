import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { ValidationError } from "../shared/errors";
import { PgBaseRepository } from "../db/pg-base";
import {
  priceAiVoiceUsage,
  type AiVoiceUsagePrice,
} from "./voice-usage-pricing";
import type { VoiceUsageCostRepository } from "./voice-usage-cost";

const REQUIRED_VOICE_COST_PROVIDERS = ["twilio", "stt", "tts", "llm"] as const;

export interface VoiceUsageBillingServiceDeps {
  pool: Pool;
  usageRepo: Pick<VoiceUsageCostRepository, "summarizePeriod">;
  stripeApiKey: string;
  fetchFn?: typeof fetch;
  settlementRepo: VoiceUsageSettlementRepository;
}

export type VoiceUsageSettlement = AiVoiceUsagePrice & {
  invoiceItemId: string | null;
};

export interface VoiceUsageSettlementRow {
  id: string;
  tenantId: string;
  periodStart: Date;
  periodEnd: Date;
  status: "pending" | "completed" | "failed";
  stripeInvoiceItemId: string | null;
}
export interface VoiceUsageSettlementRepository {
  ensurePending(input: {
    id: string;
    tenantId: string;
    periodStart: Date;
    periodEnd: Date;
    usageSeconds: number;
    providerCostMicroCents: number;
    customerChargeCents: number;
  }): Promise<VoiceUsageSettlementRow>;
  markCompleted(
    tenantId: string,
    id: string,
    stripeInvoiceItemId: string,
  ): Promise<void>;
  fail(tenantId: string, id: string, error: string): Promise<void>;
}

export class PgVoiceUsageSettlementRepository
  extends PgBaseRepository
  implements VoiceUsageSettlementRepository
{
  constructor(pool: Pool) {
    super(pool);
  }
  async ensurePending(
    input: Parameters<VoiceUsageSettlementRepository["ensurePending"]>[0],
  ): Promise<VoiceUsageSettlementRow> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `INSERT INTO ai_voice_usage_settlements
          (id,tenant_id,period_start,period_end,usage_seconds,provider_cost_micro_cents,customer_charge_cents,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
         ON CONFLICT (tenant_id,period_start,period_end) DO UPDATE SET updated_at=NOW()
         RETURNING *`,
        [
          input.id,
          input.tenantId,
          input.periodStart,
          input.periodEnd,
          input.usageSeconds,
          input.providerCostMicroCents,
          input.customerChargeCents,
        ],
      );
      const row = result.rows[0];
      return {
        id: row.id as string,
        tenantId: row.tenant_id as string,
        periodStart: new Date(row.period_start as string),
        periodEnd: new Date(row.period_end as string),
        status: row.status as VoiceUsageSettlementRow["status"],
        stripeInvoiceItemId:
          (row.stripe_invoice_item_id as string | null) ?? null,
      };
    });
  }
  async markCompleted(
    tenantId: string,
    id: string,
    stripeInvoiceItemId: string,
  ): Promise<void> {
    await this.withTenant(tenantId, (c) =>
      c
        .query(
          `UPDATE ai_voice_usage_settlements SET status='completed',stripe_invoice_item_id=$3,last_error=NULL,updated_at=NOW() WHERE tenant_id=$1 AND id=$2`,
          [tenantId, id, stripeInvoiceItemId],
        )
        .then(() => undefined),
    );
  }
  async fail(tenantId: string, id: string, error: string): Promise<void> {
    await this.withTenant(tenantId, (c) =>
      c
        .query(
          `UPDATE ai_voice_usage_settlements SET status='failed',last_error=$3,updated_at=NOW() WHERE tenant_id=$1 AND id=$2`,
          [tenantId, id, error.slice(0, 500)],
        )
        .then(() => undefined),
    );
  }
}

/** Converts one closed billing period's durable cost ledger into a Stripe overage. */
export class VoiceUsageBillingService {
  constructor(private readonly deps: VoiceUsageBillingServiceDeps) {}

  async previewCurrentPeriod(tenantId: string) {
    const tenant = await this.deps.pool.query<{
      stripe_subscription_id: string | null;
    }>(`SELECT stripe_subscription_id FROM tenants WHERE id = $1`, [tenantId]);
    const subscriptionId = tenant.rows[0]?.stripe_subscription_id;
    if (!subscriptionId) {
      throw new ValidationError(
        "Tenant has no Stripe subscription for voice usage",
      );
    }

    const fetchFn = this.deps.fetchFn ?? fetch;
    const response = await fetchFn(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { headers: { Authorization: `Bearer ${this.deps.stripeApiKey}` } },
    );
    if (!response.ok) {
      throw new Error(
        `Stripe subscription lookup failed (${response.status}): ${await response.text()}`,
      );
    }
    const subscription = (await response.json()) as {
      current_period_start?: number;
      current_period_end?: number;
      items?: {
        data?: Array<{
          current_period_start?: number;
          current_period_end?: number;
        }>;
      };
    };
    const firstItem = subscription.items?.data?.[0];
    const periodStartSeconds =
      subscription.current_period_start ?? firstItem?.current_period_start;
    const periodEndSeconds =
      subscription.current_period_end ?? firstItem?.current_period_end;
    if (
      typeof periodStartSeconds !== "number" ||
      typeof periodEndSeconds !== "number"
    ) {
      throw new Error(
        "Stripe subscription response omitted the current billing period",
      );
    }
    return this.previewPeriod({
      tenantId,
      periodStart: new Date(periodStartSeconds * 1000),
      periodEnd: new Date(periodEndSeconds * 1000),
    });
  }

  async previewPeriod(input: {
    tenantId: string;
    periodStart: Date;
    periodEnd: Date;
  }) {
    const summary = await this.deps.usageRepo.summarizePeriod(
      input.tenantId,
      input.periodStart,
      input.periodEnd,
    );
    const missingProviders = REQUIRED_VOICE_COST_PROVIDERS.filter(
      (p) => !summary.providers.includes(p),
    );
    const price = priceAiVoiceUsage(summary);
    return {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      usageSeconds: summary.usageSeconds,
      includedMinutes: 30,
      providerCostMicroCents: summary.providerCostMicroCents,
      projectedChargeCents: price.customerChargeCents,
      complete:
        summary.usageSeconds === 0 ||
        (missingProviders.length === 0 && summary.incompleteSessionCount === 0),
      missingProviders,
      incompleteSessionCount: summary.incompleteSessionCount,
    };
  }

  async settlePeriod(input: {
    tenantId: string;
    periodStart: Date;
    periodEnd: Date;
    stripeInvoiceId?: string;
  }): Promise<VoiceUsageSettlement> {
    if (!(input.periodStart < input.periodEnd)) {
      throw new ValidationError("Voice usage billing period is invalid");
    }
    const summary = await this.deps.usageRepo.summarizePeriod(
      input.tenantId,
      input.periodStart,
      input.periodEnd,
    );
    const missingProviders = REQUIRED_VOICE_COST_PROVIDERS.filter(
      (provider) => !summary.providers.includes(provider),
    );
    if (summary.usageSeconds > 0 && missingProviders.length > 0) {
      throw new ValidationError(
        `AI voice provider cost data is incomplete; missing: ${missingProviders.join(", ")}`,
      );
    }
    if (summary.incompleteSessionCount > 0) {
      throw new ValidationError(
        `AI voice provider cost data is incomplete for ${summary.incompleteSessionCount} session(s)`,
      );
    }
    const price = priceAiVoiceUsage(summary);
    if (price.customerChargeCents === 0)
      return { ...price, invoiceItemId: null };

    const customer = await this.deps.pool.query<{
      stripe_customer_id: string | null;
    }>(`SELECT stripe_customer_id FROM tenants WHERE id = $1`, [
      input.tenantId,
    ]);
    const customerId = customer.rows[0]?.stripe_customer_id;
    if (!customerId)
      throw new ValidationError(
        "Tenant has no Stripe customer for voice overage",
      );

    const settlement = await this.deps.settlementRepo.ensurePending({
      id: randomUUID(),
      tenantId: input.tenantId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      usageSeconds: summary.usageSeconds,
      providerCostMicroCents: summary.providerCostMicroCents,
      customerChargeCents: price.customerChargeCents,
    });
    if (settlement.status === "completed" && settlement.stripeInvoiceItemId) {
      return { ...price, invoiceItemId: settlement.stripeInvoiceItemId };
    }
    const body = new URLSearchParams();
    body.set("customer", customerId);
    if (input.stripeInvoiceId) body.set("invoice", input.stripeInvoiceId);
    body.set("amount", String(price.customerChargeCents));
    body.set("currency", "usd");
    body.set(
      "description",
      "AI voice usage overage — actual provider cost + 30%",
    );
    body.set("metadata[tenant_id]", input.tenantId);
    body.set("metadata[period_start]", input.periodStart.toISOString());
    body.set("metadata[period_end]", input.periodEnd.toISOString());
    body.set("metadata[usage_seconds]", String(summary.usageSeconds));
    body.set(
      "metadata[provider_cost_micro_cents]",
      String(summary.providerCostMicroCents),
    );

    const fetchFn = this.deps.fetchFn ?? fetch;
    const response = await fetchFn("https://api.stripe.com/v1/invoiceitems", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.deps.stripeApiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `ai-voice-overage:${settlement.id}`,
      },
      body,
    });
    if (!response.ok) {
      const message = `Stripe voice overage invoice item failed (${response.status}): ${await response.text()}`;
      await this.deps.settlementRepo.fail(
        input.tenantId,
        settlement.id,
        message,
      );
      throw new Error(message);
    }
    const created = (await response.json()) as { id?: string };
    if (!created.id) {
      const message = "Stripe voice overage invoice item returned no id";
      await this.deps.settlementRepo.fail(
        input.tenantId,
        settlement.id,
        message,
      );
      throw new Error(message);
    }
    await this.deps.settlementRepo.markCompleted(
      input.tenantId,
      settlement.id,
      created.id,
    );
    return { ...price, invoiceItemId: created.id };
  }
}
