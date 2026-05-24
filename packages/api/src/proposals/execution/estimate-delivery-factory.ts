import type { SendService } from '../../notifications/send-service';
import { SendServiceEstimateDeliveryProvider } from '../../notifications/estimate-delivery-adapter';
import { NoopEstimateDeliveryProvider } from './voice-extended-handlers';
import type { EstimateDeliveryProvider } from './voice-extended-handlers';

export function resolveEstimateDeliveryProvider(opts: {
  nodeEnv: string;
  sendService: SendService | undefined;
}): EstimateDeliveryProvider {
  if (opts.sendService) {
    return new SendServiceEstimateDeliveryProvider(opts.sendService);
  }
  if (
    opts.nodeEnv === 'prod' ||
    opts.nodeEnv === 'production' ||
    opts.nodeEnv === 'staging'
  ) {
    throw new Error(
      'Estimate delivery requires SendService in production/staging. Configure Twilio/SendGrid credentials.',
    );
  }
  return new NoopEstimateDeliveryProvider();
}
