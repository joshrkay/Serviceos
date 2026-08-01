import { DelayNotificationService } from './delay-notifications';
import { MessageDeliveryProvider } from './delivery-provider';
import { DispatchEntityType, DispatchRepository } from './dispatch-repository';
import type { CustomerRepository } from '../customers/customer';

/**
 * Real implementation of DelayNotificationService that routes delay notices
 * through the shared MessageDeliveryProvider (Twilio SMS / SendGrid email)
 * and records a message_dispatches row for audit and the /interactions page.
 */
export class TwilioDelayNotificationService implements DelayNotificationService {
  constructor(
    private readonly delivery: MessageDeliveryProvider,
    private readonly dispatchRepo: DispatchRepository,
    /**
     * WS1 — used to load the recipient customer's sms_consent so the central
     * gate can enforce it on the SMS channel. Optional: when absent, a customer
     * SMS carries no consent context and the gate fails closed in 'block' mode.
     */
    private readonly customerRepo?: Pick<CustomerRepository, 'findById'>,
  ) {}

  async sendDelayNotice(request: {
    tenantId: string;
    customerId: string;
    channel: 'sms' | 'email';
    destination: string;
    message: string;
    idempotencyKey: string;
    entityType?: DispatchEntityType;
    metadata?: Record<string, unknown>;
  }): Promise<{ providerMessageId?: string }> {
    const entityId =
      typeof request.metadata?.appointmentId === 'string'
        ? request.metadata.appointmentId
        : request.customerId;
    const entityType: DispatchEntityType = request.entityType ?? 'delay_notice';

    if (request.channel === 'sms') {
      // WS1 — delay notices are customer-facing; load the stored consent flag
      // so the central gate can enforce consent + DNC.
      const customer = this.customerRepo
        ? await this.customerRepo.findById(request.tenantId, request.customerId)
        : null;
      const result = await this.delivery.sendSms({
        to: request.destination,
        body: request.message,
        tenantId: request.tenantId,
        idempotencyKey: request.idempotencyKey,
        recipientClass: 'customer',
        ...(customer
          ? { consent: { smsConsent: customer.smsConsent === true, customerId: customer.id } }
          : {}),
      });
      await this.dispatchRepo.create({
        tenantId: request.tenantId,
        entityType,
        entityId,
        channel: 'sms',
        recipient: request.destination,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: 'sent',
        idempotencyKey: request.idempotencyKey,
      });
      return { providerMessageId: result.providerMessageId };
    }

    const result = await this.delivery.sendEmail({
      to: request.destination,
      subject: 'Update about your upcoming appointment',
      text: request.message,
      html: `<p>${request.message.replace(/\n/g, '<br>')}</p>`,
      tenantId: request.tenantId,
      idempotencyKey: request.idempotencyKey,
    });
    await this.dispatchRepo.create({
      tenantId: request.tenantId,
      entityType,
      entityId,
      channel: 'email',
      recipient: request.destination,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      status: 'sent',
      idempotencyKey: request.idempotencyKey,
    });
    return { providerMessageId: result.providerMessageId };
  }
}
