import { MessageDeliveryProvider } from './delivery-provider';
import { DispatchRepository } from './dispatch-repository';
import type { CustomerRepository } from '../customers/customer';
import type {
  CustomerMessenger,
  CustomerMessengerInput,
  CustomerMessengerResult,
} from '../proposals/execution/send-customer-message-handler';

/**
 * Quality-review fix — the owner approves PLAIN TEXT on the review card
 * (`body` is a Zod string, never HTML). Escaping entities BEFORE the
 * newline→`<br>` replace below means the customer's email client can never
 * render a live link, tag, or markup the card never rendered — e.g. a
 * spoken "less than 3 minutes away" or a pasted-sounding "<STOP>" renders
 * as literal text, not a stray tag. Deliberately scoped to THIS service
 * only: `TwilioDelayNotificationService`'s sibling email path
 * (`notifications/twilio-delay-notification-service.ts`) is untouched —
 * its `message` is built from OPERATOR-typed template strings, settled
 * precedent, never raw customer- or transcript-sourced text.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Real implementation of `CustomerMessenger` (Tradesperson wave 1, Task 5).
 *
 * Sends a free-form, owner-approved customer message through the SAME
 * `MessageDeliveryProvider` (Twilio SMS / SendGrid email) + message_dispatches
 * audit trail `TwilioDelayNotificationService` uses for delay notices —
 * `delivery` is the identical gated instance app.ts wires for both classes,
 * so the TCPA consent + DNC + channel kill-switch gates
 * (`notifications/gated-message-delivery.ts`) apply exactly the same way. No
 * new Twilio/SendGrid touchpoint is introduced.
 *
 * ── Why this is NOT a thin wrapper over `TwilioDelayNotificationService`
 *    (Step 1's exemplar) ────────────────────────────────────────────────
 *
 * `DelayNotificationService.sendDelayNotice()` can carry an arbitrary
 * `message` string just fine, but its CONCRETE email path
 * (`TwilioDelayNotificationService`) hardcodes the subject line to "Update
 * about your upcoming appointment" — correct for a delay/en-route notice,
 * actively misleading for a truly free-form message ("the part arrived",
 * "we're finished, the gate is locked", "the inspection passed") that may
 * have nothing to do with an appointment at all. Layering on top of that
 * service would either ship a wrong subject on every emailed
 * `send_customer_message`, or require reaching into
 * `TwilioDelayNotificationService` to override behavior that exists
 * specifically to serve a different proposal type.
 *
 * `MessageDeliveryProvider` — the lower-level abstraction
 * `TwilioDelayNotificationService` itself is built on — has no such
 * assumption baked in, so this class talks to it directly instead: same
 * "existing service layer," same gates, zero hand-rolled Twilio/SendGrid
 * calls, and a subject line this proposal type actually controls. Every
 * other structural choice below (consent-context lookup for SMS, dispatch-
 * row shape, letting the gate's thrown error propagate to the caller) is a
 * deliberate line-for-line mirror of `TwilioDelayNotificationService`.
 */
export class TwilioCustomerMessageService implements CustomerMessenger {
  constructor(
    private readonly delivery: MessageDeliveryProvider,
    private readonly dispatchRepo: DispatchRepository,
    /**
     * Used to look up the recipient's phone/email and (for SMS) their
     * stored `sms_consent` flag so the central gate can enforce it —
     * mirrors `TwilioDelayNotificationService`'s optional `customerRepo`.
     */
    private readonly customerRepo: Pick<CustomerRepository, 'findById'>,
  ) {}

  async sendCustomMessage(input: CustomerMessengerInput): Promise<CustomerMessengerResult> {
    const customer = await this.customerRepo.findById(input.tenantId, input.customerId);
    if (!customer) {
      throw new Error(`Customer ${input.customerId} not found`);
    }

    if (input.channel === 'sms') {
      if (!customer.primaryPhone) {
        throw new Error('Customer has no phone number on file for SMS');
      }
      const result = await this.delivery.sendSms({
        to: customer.primaryPhone,
        body: input.body,
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        recipientClass: 'customer',
        consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
      });
      const dispatch = await this.dispatchRepo.create({
        tenantId: input.tenantId,
        entityType: 'custom_message',
        entityId: input.customerId,
        channel: 'sms',
        recipient: customer.primaryPhone,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: 'sent',
        idempotencyKey: input.idempotencyKey,
      });
      return { dispatchId: dispatch.id };
    }

    if (!customer.email) {
      throw new Error('Customer has no email address on file');
    }
    const result = await this.delivery.sendEmail({
      to: customer.email,
      // The owner never sees this default on the review card (the contract
      // has no spoken-subject extraction seam today — the taxonomy only
      // captures customerMessageBody/customerMessageChannel); a future
      // spoken-subject field is a possible follow-up, not this task's scope.
      subject: input.subject ?? 'A message from your service provider',
      text: input.body,
      html: `<p>${escapeHtml(input.body).replace(/\n/g, '<br>')}</p>`,
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
    });
    const dispatch = await this.dispatchRepo.create({
      tenantId: input.tenantId,
      entityType: 'custom_message',
      entityId: input.customerId,
      channel: 'email',
      recipient: customer.email,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      status: 'sent',
      idempotencyKey: input.idempotencyKey,
    });
    return { dispatchId: dispatch.id };
  }
}
