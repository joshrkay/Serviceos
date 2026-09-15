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
      // #1145 — distinguishes this AI-proposal-triggered send from an
      // unrelated owner manual send landing in the same wall-clock minute,
      // so the two don't collide on idx_dispatches_idempotency.
      idempotencyContext: 'proposal',
    });
    const first = result.channelsSent[0];
    return { providerMessageId: first?.providerMessageId };
  }
}
