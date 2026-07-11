import { MessageDeliveryProvider } from './delivery-provider';
import { DispatchRepository, DispatchEntityType } from './dispatch-repository';
import { Customer } from '../customers/customer';

export type CustomerMessageChannel = 'sms' | 'email';

export interface CustomerMessageDeliveryDeps {
  delivery: MessageDeliveryProvider;
  dispatchRepo: DispatchRepository;
}

export interface SendCustomerMessageInput {
  tenantId: string;
  customer: Customer;
  entityType: DispatchEntityType;
  entityId: string;
  channels: CustomerMessageChannel[];
  smsBody?: string;
  emailSubject?: string;
  emailText?: string;
  emailHtml?: string;
  idempotencyKeyPrefix: string;
}

/**
 * Best-effort SMS/email send with dispatch logging. The sms_consent + DNC gate
 * is applied centrally by the GatedMessageDelivery wrapper (`delivery`); this
 * function just declares the audience (customer) and forwards the stored
 * consent flag. A suppressed send throws inside sendSms and is swallowed here,
 * so transactional comms never block business mutations.
 */
export async function sendCustomerMessage(
  deps: CustomerMessageDeliveryDeps,
  input: SendCustomerMessageInput,
): Promise<void> {
  const { customer, tenantId, channels } = input;

  if (channels.includes('sms') && input.smsBody && customer.primaryPhone) {
    const idempotencyKey = `${input.idempotencyKeyPrefix}:sms`;
    try {
      const result = await deps.delivery.sendSms({
        to: customer.primaryPhone,
        body: input.smsBody,
        tenantId,
        idempotencyKey,
        recipientClass: 'customer',
        consent: { smsConsent: customer.smsConsent === true, customerId: customer.id },
      });
      await deps.dispatchRepo.create({
        tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        channel: 'sms',
        recipient: customer.primaryPhone,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: 'sent',
        idempotencyKey,
      });
    } catch {
      // Best-effort (includes central gate suppression).
    }
  }

  if (
    channels.includes('email') &&
    input.emailSubject &&
    input.emailText &&
    customer.email
  ) {
    const idempotencyKey = `${input.idempotencyKeyPrefix}:email`;
    try {
      const result = await deps.delivery.sendEmail({
        to: customer.email,
        subject: input.emailSubject,
        text: input.emailText,
        html: input.emailHtml,
        tenantId,
        idempotencyKey,
      });
      await deps.dispatchRepo.create({
        tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        channel: 'email',
        recipient: customer.email,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: 'sent',
        idempotencyKey,
      });
    } catch {
      // Best-effort.
    }
  }
}
