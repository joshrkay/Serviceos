import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  createWebhookRouter,
  type WebhookRouterDeps,
} from "../../src/webhooks/routes";
import {
  createWebhookSignature,
  InMemoryWebhookRepository,
} from "../../src/webhooks/webhook-handler";
import type { CallUsageBillingService } from "../../src/billing/call-usage-billing";

const SECRET = "whsec_call_usage_test";
const TENANT = "11111111-1111-4111-8111-111111111111";

function buildApp(deps: WebhookRouterDeps) {
  const app = express();
  app.use("/webhooks/stripe", express.raw({ type: "*/*" }));
  app.use("/webhooks", createWebhookRouter({} as never, deps));
  return app;
}

async function postInvoiceCreated(
  app: express.Express,
  eventId = "evt_invoice_created",
  billingReason = "subscription_cycle",
) {
  const raw = JSON.stringify({
    id: eventId,
    type: "invoice.created",
    data: {
      object: {
        id: "in_123",
        customer: "cus_123",
        billing_reason: billingReason,
        period_start: 1_788_220_800,
        period_end: 1_790_899_200,
        lines: {
          data: [
            { type: "invoiceitem", price: { id: "price_setup_fee" } },
            { type: "subscription", price: { id: "price_growth" } },
          ],
        },
      },
    },
  });
  return request(app)
    .post("/webhooks/stripe")
    .set("stripe-signature", createWebhookSignature(raw, SECRET))
    .set("content-type", "application/json")
    .send(raw);
}

function appWith(settlePeriod: ReturnType<typeof vi.fn>) {
  return buildApp({
    webhookRepo: new InMemoryWebhookRepository(),
    stripeWebhookSecret: SECRET,
    pool: { query: vi.fn(async () => ({ rows: [{ id: TENANT }] })) } as never,
    callUsageBillingService: { settlePeriod } as unknown as CallUsageBillingService,
  });
}

describe("Stripe invoice.created per-call settlement", () => {
  it("settles the closed period once, on the invoice's subscription price", async () => {
    const settlePeriod = vi.fn(async () => ({ invoiceItemId: "ii_123" }));
    const app = appWith(settlePeriod);

    expect((await postInvoiceCreated(app)).status).toBe(200);
    expect((await postInvoiceCreated(app)).status).toBe(200);

    expect(settlePeriod).toHaveBeenCalledTimes(1);
    expect(settlePeriod).toHaveBeenCalledWith({
      tenantId: TENANT,
      periodStart: new Date(1_788_220_800_000),
      periodEnd: new Date(1_790_899_200_000),
      subscriptionPriceId: "price_growth",
      stripeInvoiceId: "in_123",
    });
  });

  it("does not settle the first invoice of a new subscription", async () => {
    const settlePeriod = vi.fn();
    const app = appWith(settlePeriod);

    expect((await postInvoiceCreated(app, "evt_create", "subscription_create")).status).toBe(200);
    expect(settlePeriod).not.toHaveBeenCalled();
  });

  it("returns 500 so Stripe retries when settlement fails", async () => {
    const settlePeriod = vi.fn(async () => {
      throw new Error("Stripe AI minute overage invoice item failed (503)");
    });
    const app = appWith(settlePeriod);

    expect((await postInvoiceCreated(app, "evt_fail")).status).toBe(500);
    expect(settlePeriod).toHaveBeenCalledTimes(1);
  });
});
