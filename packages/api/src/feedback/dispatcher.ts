import {
  MessageDeliveryProvider,
  SmsConsentContext,
} from '../notifications/delivery-provider';

export interface FeedbackDispatchInput {
  to: string;
  body: string;
  /** Tenant scope — required for per-tenant Twilio routing + DNC. */
  tenantId?: string;
  /** Customer consent snapshot for the central gate (customer-class send). */
  consent?: SmsConsentContext;
}

export interface FeedbackDispatcher {
  send(input: FeedbackDispatchInput): Promise<void>;
}

export class NoopFeedbackDispatcher implements FeedbackDispatcher {
  async send(_input: FeedbackDispatchInput): Promise<void> {
    // Intentionally no-op in environments without SMS credentials.
  }
}

/**
 * WS1 — feedback-request SMS goes through the single `messageDelivery` object
 * like every other product SMS, instead of the old SmsProviderFeedbackDispatcher
 * that made a raw Twilio Messages.json fetch and bypassed the consent + DNC
 * gate entirely. Feedback requests are customer-facing, so this tags every send
 * customer-class and forwards the caller's consent snapshot; the gate enforces
 * consent + DNC centrally.
 */
export class MessageDeliveryFeedbackDispatcher implements FeedbackDispatcher {
  constructor(private readonly delivery: MessageDeliveryProvider) {}

  async send(input: FeedbackDispatchInput): Promise<void> {
    await this.delivery.sendSms({
      to: input.to,
      body: input.body,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      recipientClass: 'customer',
      ...(input.consent ? { consent: input.consent } : {}),
    });
  }
}
