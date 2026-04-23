import { IReminderDispatcher } from './ReminderDispatcher';

export class SmsReminderDispatcher implements IReminderDispatcher {
  async sendConfirmationLink(_appointmentId: string, _portalUrl: string, _tenantId: string): Promise<void> {
    throw new Error('SmsReminderDispatcher: Twilio not yet configured — see Twilio SMS delivery plan');
  }

  async sendPaymentLink(_invoiceId: string, _portalUrl: string, _tenantId: string): Promise<void> {
    throw new Error('SmsReminderDispatcher: Twilio not yet configured — see Twilio SMS delivery plan');
  }
}
