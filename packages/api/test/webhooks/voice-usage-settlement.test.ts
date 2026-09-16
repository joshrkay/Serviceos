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
import type { VoiceUsageBillingService } from "../../src/billing/voice-usage-billing";

const SECRET = "whsec_voice_usage_test";
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
) {
  const raw = JSON.stringify({
    id: eventId,
    type: "invoice.created",
    data: {
      object: {
        id: "in_123",
        customer: "cus_123",
        billing_reason: "subscription_cycle",
        period_start: 1_788_220_800,
        period_end: 1_790_899_200,
      },
    },
  });
  return request(app)
    .post("/webhooks/stripe")
    .set("stripe-signature", createWebhookSignature(raw, SECRET))
    .set("content-type", "application/json")
    .send(raw);
}

describe("Stripe invoice.created voice usage settlement", () => {
  it("settles the closed billing period once and attaches the item to the draft invoice", async () => {
    const settlePeriod = vi.fn(async () => ({ invoiceItemId: "ii_123" }));
    const app = buildApp({
      webhookRepo: new InMemoryWebhookRepository(),
      stripeWebhookSecret: SECRET,
      pool: { query: vi.fn(async () => ({ rows: [{ id: TENANT }] })) } as never,
      voiceUsageBillingService: {
        settlePeriod,
      } as unknown as VoiceUsageBillingService,
    });

    expect((await postInvoiceCreated(app)).status).toBe(200);
    expect((await postInvoiceCreated(app)).status).toBe(200);

    expect(settlePeriod).toHaveBeenCalledTimes(1);
    expect(settlePeriod).toHaveBeenCalledWith({
      tenantId: TENANT,
      periodStart: new Date(1_788_220_800_000),
      periodEnd: new Date(1_790_899_200_000),
      stripeInvoiceId: "in_123",
    });
  });

  it("returns 500 so Stripe retries when provider cost reconciliation is incomplete", async () => {
    const settlePeriod = vi.fn(async () => {
      throw new Error("AI voice provider cost data is incomplete");
    });
    const app = buildApp({
      webhookRepo: new InMemoryWebhookRepository(),
      stripeWebhookSecret: SECRET,
      pool: { query: vi.fn(async () => ({ rows: [{ id: TENANT }] })) } as never,
      voiceUsageBillingService: {
        settlePeriod,
      } as unknown as VoiceUsageBillingService,
    });

    const response = await postInvoiceCreated(app, "evt_incomplete");

    expect(response.status).toBe(500);
    expect(settlePeriod).toHaveBeenCalledTimes(1);
  });
});
