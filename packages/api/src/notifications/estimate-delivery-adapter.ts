import {
  EstimateDeliveryProvider,
  EstimateDispatch,
} from '../proposals/execution/voice-extended-handlers';
import { SendService } from './send-service';

/**
 * Adapter from the proposal-execution `EstimateDeliveryProvider`
 * interface (used by `SendEstimateExecutionHandler`) to the unified
 * `SendService`. Mirrors `SendServiceInvoiceDeliveryProvider`: real
 * sends when a `SendService` exists, Noop otherwise.
 */
export class SendServiceEstimateDeliveryProvider implements EstimateDeliveryProvider {
  constructor(private readonly sendService: SendService) {}

  async send(dispatch: EstimateDispatch): Promise<{ providerMessageId?: string }> {
    const result = await this.sendService.sendEstimate({
      tenantId: dispatch.tenantId,
      estimateId: dispatch.estimateId,
      channel: dispatch.channel,
      recipientPhone: dispatch.channel === 'sms' ? dispatch.recipient : undefined,
      recipientEmail: dispatch.channel === 'email' ? dispatch.recipient : undefined,
      customMessage: dispatch.customMessage,
    });
    const first = result.channelsSent[0];
    return { providerMessageId: first?.providerMessageId };
  }
}
