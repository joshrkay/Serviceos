import type { SendService } from '../../notifications/send-service';
import { SendServiceInvoiceDeliveryProvider } from '../../notifications/invoice-delivery-adapter';
import { NoopInvoiceDeliveryProvider } from './voice-extended-handlers';
import type { InvoiceDeliveryProvider } from './voice-extended-handlers';

export function resolveInvoiceDeliveryProvider(opts: {
  nodeEnv: string;
  sendService: SendService | undefined;
}): InvoiceDeliveryProvider {
  if (opts.sendService) {
    return new SendServiceInvoiceDeliveryProvider(opts.sendService);
  }
  if (
    opts.nodeEnv === 'prod' ||
    opts.nodeEnv === 'production' ||
    opts.nodeEnv === 'staging'
  ) {
    throw new Error(
      'Invoice delivery requires SendService in production/staging. Configure Twilio/SendGrid credentials.',
    );
  }
  return new NoopInvoiceDeliveryProvider();
}
