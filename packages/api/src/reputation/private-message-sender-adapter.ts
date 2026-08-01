/**
 * P7-026 final wiring — `ReviewPrivateMessageSender` adapter over the
 * unified `MessageDeliveryProvider`.
 *
 * The execution handler's surface is intentionally minimal: send a
 * `{channel, body, customerId, tenantId, idempotencyKey}` blob and
 * return a `{providerMessageId}`. The provider speaks SMS / email
 * separately and needs the recipient's phone / email address — this
 * adapter resolves the address from the customer row before
 * delegating.
 *
 * Lives under `reputation/` (not `notifications/`) per the P7-026
 * allowed-files rule: the notification layer is read-only for this
 * story, so the adapter wraps it externally.
 *
 * Failure modes surface as thrown errors so the handler's catch block
 * records the `{ok: false, error: ...}` sub-result and the operator
 * sees the cause in the audit metadata. We do not retry inside the
 * adapter — that's the executor's job at the proposal layer.
 */
import type {
  ReviewPrivateMessageSender,
  ReviewPrivateMessageResult,
} from '../proposals/execution/review-response-handler';
import type {
  DeliveryResult,
  MessageDeliveryProvider,
} from '../notifications/delivery-provider';
import type { CustomerRepository } from '../customers/customer';
import { SmsSuppressedError } from '../notifications/gated-message-delivery';

export interface ReviewPrivateMessageSenderInput {
  tenantId: string;
  customerId: string;
  channel: 'email' | 'sms';
  body: string;
  idempotencyKey: string;
}

const DEFAULT_EMAIL_SUBJECT = 'Following up on your recent review';

export class MessageDeliveryReviewPrivateMessageSender
  implements ReviewPrivateMessageSender
{
  constructor(
    private readonly delivery: MessageDeliveryProvider,
    private readonly customerRepo: CustomerRepository,
    private readonly emailSubject: string = DEFAULT_EMAIL_SUBJECT,
  ) {}

  async send(
    input: ReviewPrivateMessageSenderInput,
  ): Promise<ReviewPrivateMessageResult> {
    const customer = await this.customerRepo.findById(
      input.tenantId,
      input.customerId,
    );
    if (!customer) {
      throw new Error(
        `customer_not_found: ${input.customerId} in tenant ${input.tenantId}`,
      );
    }

    let result: DeliveryResult;
    if (input.channel === 'sms') {
      if (!customer.primaryPhone) {
        throw new Error(`missing_phone: customer ${input.customerId}`);
      }
      // §7 / WS1 — the consent + DNC gate is applied centrally by the
      // GatedMessageDelivery wrapper. A suppressed send throws
      // SmsSuppressedError; translate it back into this handler's
      // {suppressed, reason} contract so an opted-out number is recorded as a
      // non-failure sub-result (the executor sees the reason in audit metadata).
      try {
        result = await this.delivery.sendSms({
          to: customer.primaryPhone,
          body: input.body,
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          recipientClass: 'customer',
          consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
        });
      } catch (err) {
        if (err instanceof SmsSuppressedError) {
          return {
            suppressed: true,
            reason: err.reason === 'dnc' ? 'dnc' : 'no_consent',
          };
        }
        throw err;
      }
    } else {
      if (!customer.email) {
        throw new Error(`missing_email: customer ${input.customerId}`);
      }
      result = await this.delivery.sendEmail({
        to: customer.email,
        subject: this.emailSubject,
        // Plain-text body is required; HTML is optional. The body
        // composer (`reputation/draft-private-followup.ts`) already
        // produces plain prose, so we forward it verbatim to both
        // fields — the email client will render the HTML version.
        text: input.body,
        html: `<p>${escapeHtml(input.body).replace(/\n/g, '<br>')}</p>`,
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
      });
    }
    return { providerMessageId: result.providerMessageId };
  }
}

/** Minimal HTML escaper for the email body. Mirrors the helper used by
 *  `appointment-confirmation-notifier.ts`. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
