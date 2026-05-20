import {
  InvoiceDeliveryProvider,
  InvoiceDispatch,
} from '../proposals/execution/voice-extended-handlers';
import { SendService } from './send-service';

/**
 * Adapter from the proposal-execution `InvoiceDeliveryProvider`
 * interface (used by `SendInvoiceExecutionHandler`) to the new
 * unified `SendService`. Wired via `resolveInvoiceDeliveryProvider` in
 * `app.ts`: real sends when `SendService` exists; prod/staging boot
 * fails if missing; dev/test uses Noop.
 */
export class SendServiceInvoiceDeliveryProvider implements InvoiceDeliveryProvider {
  constructor(private readonly sendService: SendService) {}

  async send(dispatch: InvoiceDispatch): Promise<{ providerMessageId?: string }> {
    const result = await this.sendService.sendInvoice({
      tenantId: dispatch.tenantId,
      invoiceId: dispatch.invoiceId,
      channel: dispatch.channel,
      recipientPhone: dispatch.channel === 'sms' ? dispatch.recipient : undefined,
      recipientEmail: dispatch.channel === 'email' ? dispatch.recipient : undefined,
      customMessage: dispatch.customMessage,
    });
    const first = result.channelsSent[0];
    return { providerMessageId: first?.providerMessageId };
  }
}
