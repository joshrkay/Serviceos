export interface IReminderDispatcher {
  sendConfirmationLink(appointmentId: string, portalUrl: string, tenantId: string): Promise<void>;
  sendPaymentLink(invoiceId: string, portalUrl: string, tenantId: string): Promise<void>;
}

export class NoopReminderDispatcher implements IReminderDispatcher {
  async sendConfirmationLink(appointmentId: string, portalUrl: string, _tenantId: string): Promise<void> {
    console.log(`[NoopDispatcher] confirmation link for ${appointmentId}: ${portalUrl}`);
  }

  async sendPaymentLink(invoiceId: string, portalUrl: string, _tenantId: string): Promise<void> {
    console.log(`[NoopDispatcher] payment link for ${invoiceId}: ${portalUrl}`);
  }
}
