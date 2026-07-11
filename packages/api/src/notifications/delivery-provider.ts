/**
 * Unified message delivery provider interface for SMS and email.
 *
 * One interface, two channels. Production provider wraps Twilio
 * (Programmable Messaging for SMS, SendGrid for email — same vendor,
 * one set of credentials to manage).
 *
 * The interface is deliberately small:
 *   - sendSms() takes a phone + body
 *   - sendEmail() takes an email + subject + html/text bodies
 *
 * Routes that need to send a message accept this interface and stay
 * provider-agnostic. Production swaps the implementation in app.ts;
 * tests pass an InMemoryDeliveryProvider that records what would have
 * been sent.
 */

/**
 * Who an outbound SMS is addressed to, for the single consent+DNC gate
 * (see notifications/gated-message-delivery.ts).
 *
 *   - 'customer' — a message to an end customer. Subject to the TCPA
 *     consent + tenant DNC gate; requires a `consent` context.
 *   - 'owner'    — a message to the business owner / operator / on-call
 *     tech (digests, one-tap approval links, emergency pages, dispatcher
 *     patch/notify). Never blocked by customer consent or DNC.
 *
 * Required so every send site is forced to declare its audience — the
 * gate fails closed on a customer send with no consent context.
 */
export type SmsRecipientClass = 'customer' | 'owner';

/** Consent snapshot the gate needs to decide a customer send. */
export interface SmsConsentContext {
  /** The customer's stored sms_consent flag. Must be true to send in 'block' mode. */
  smsConsent: boolean;
  /** Optional customer id — used for the suppression audit entityId. */
  customerId?: string;
}

export interface SmsMessage {
  to: string;
  body: string;
  /** Optional per-tenant identifier for cost accounting + routing. */
  tenantId?: string;
  /** Optional idempotency key — provider should dedupe within ~24h. */
  idempotencyKey?: string;
  /**
   * REQUIRED audience tag. Drives the consent+DNC gate: 'owner' bypasses,
   * 'customer' is gated. Every call site must set this explicitly.
   */
  recipientClass: SmsRecipientClass;
  /**
   * Consent context for a customer send. Absent on a 'customer' message
   * makes the gate fail closed (missing_consent_context). Ignored for 'owner'.
   */
  consent?: SmsConsentContext;
}

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Required — used as fallback for clients that block HTML. */
  text: string;
  /** Optional HTML body. Most clients prefer this when present. */
  html?: string;
  /** Optional override of the configured from address. */
  from?: string;
  /** Optional override of the configured reply-to address. */
  replyTo?: string;
  /** Optional per-tenant identifier for cost accounting. */
  tenantId?: string;
  /** Optional idempotency key — provider should dedupe within ~24h. */
  idempotencyKey?: string;
}

export interface DeliveryResult {
  /** Provider's message ID — use for delivery-status webhooks later. */
  providerMessageId: string;
  /** Provider name for observability. */
  provider: string;
  /** Channel that delivered the message. */
  channel: 'sms' | 'email';
}

export interface MessageDeliveryProvider {
  sendSms(message: SmsMessage): Promise<DeliveryResult>;
  sendEmail(message: EmailMessage): Promise<DeliveryResult>;
}

/**
 * Records dispatched messages without sending bytes. Default in dev
 * and tests so the app boots without provider credentials and tests
 * can assert what would have been sent.
 *
 * SAFETY: throws in production. If a real send is attempted while
 * this provider is wired in production, fail loud at the call site
 * rather than silently dropping customer-facing messages.
 */
export class InMemoryDeliveryProvider implements MessageDeliveryProvider {
  readonly sentSms: SmsMessage[] = [];
  readonly sentEmails: EmailMessage[] = [];

  constructor(private readonly allowInProduction: boolean = false) {
    if (process.env.NODE_ENV === 'production' && !allowInProduction) {
      throw new Error(
        'InMemoryDeliveryProvider cannot be used in production — wire a real MessageDeliveryProvider'
      );
    }
  }

  async sendSms(message: SmsMessage): Promise<DeliveryResult> {
    this.sentSms.push(message);
    return {
      providerMessageId: `mem-sms-${this.sentSms.length}`,
      provider: 'in-memory',
      channel: 'sms',
    };
  }

  async sendEmail(message: EmailMessage): Promise<DeliveryResult> {
    this.sentEmails.push(message);
    return {
      providerMessageId: `mem-email-${this.sentEmails.length}`,
      provider: 'in-memory',
      channel: 'email',
    };
  }

  reset(): void {
    this.sentSms.length = 0;
    this.sentEmails.length = 0;
  }
}
