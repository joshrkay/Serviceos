import { describe, it, expect } from 'vitest';
import { NoopReminderDispatcher } from '../../src/reminders/ReminderDispatcher';

describe('NoopReminderDispatcher', () => {
  it('resolves without throwing for sendConfirmationLink', async () => {
    const d = new NoopReminderDispatcher();
    await expect(
      d.sendConfirmationLink('appt-1', 'https://example.com/portal/confirm/tok', 'tenant-1'),
    ).resolves.toBeUndefined();
  });

  it('resolves without throwing for sendPaymentLink', async () => {
    const d = new NoopReminderDispatcher();
    await expect(
      d.sendPaymentLink('inv-1', 'https://example.com/portal/pay/tok', 'tenant-1'),
    ).resolves.toBeUndefined();
  });
});
