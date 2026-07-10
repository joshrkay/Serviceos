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
import { type DncRepository, normalizePhone } from '../compliance/dnc';

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
    // §7 compliance gate. SMS follow-ups are suppressed when the recipient is
    // on the tenant DNC list or has not granted SMS consent — the same gate
    // every other outbound SMS path enforces (send-service.ts,
    // customer-message-delivery.ts). Without it, a customer who texted STOP
    // still receives a review private follow-up (a TCPA violation).
    private readonly dncRepo: Pick<DncRepository, 'isOnDnc'>,
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
      // Compliance gate BEFORE the transport — never text an opted-out number.
      if (customer.smsConsent !== true) {
        return { suppressed: true, reason: 'no_consent' };
      }
      if (await this.dncRepo.isOnDnc(input.tenantId, normalizePhone(customer.primaryPhone))) {
        return { suppressed: true, reason: 'dnc' };
      }
      result = await this.delivery.sendSms({
        to: customer.primaryPhone,
        body: input.body,
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
      });
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
