import type { SendService } from '../../notifications/send-service';
import { SendServiceEstimateDeliveryProvider } from '../../notifications/estimate-delivery-adapter';
import { NoopEstimateDeliveryProvider } from './voice-extended-handlers';
import type { EstimateDeliveryProvider } from './voice-extended-handlers';

function isProductionLike(nodeEnv: string): boolean {
  return nodeEnv === 'prod' || nodeEnv === 'production' || nodeEnv === 'staging';
}

export function resolveEstimateDeliveryProvider(opts: {
  nodeEnv: string;
  sendService: SendService | undefined;
  /**
   * When Twilio/SendGrid are explicitly opted out via EMAIL_ENABLED=false
   * and TELEPHONY_ENABLED=false, allow the noop provider in prod/staging
   * instead of refusing to boot.
   */
  allowNoopInProduction?: boolean;
}): EstimateDeliveryProvider {
  if (opts.sendService) {
    return new SendServiceEstimateDeliveryProvider(opts.sendService);
  }
  if (isProductionLike(opts.nodeEnv) && !opts.allowNoopInProduction) {
    throw new Error(
      'Estimate delivery requires SendService in production/staging. Configure Twilio/SendGrid credentials.',
    );
  }
  return new NoopEstimateDeliveryProvider();
}
