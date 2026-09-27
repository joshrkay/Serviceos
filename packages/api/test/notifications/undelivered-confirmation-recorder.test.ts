/**
 * #1077 / PRD row 3.8 — the no-delivery-provider confirmation recorder. The
 * failed-row write itself is pinned at real Postgres through the production
 * execution registry (test/integration/appointment-confirmation-dispatch-3-8);
 * these pin the skips it shares with the live notifier, which are owner
 * choices or missing contact details — not delivery failures.
 */
import { describe, it, expect } from 'vitest';
import { UndeliveredConfirmationRecorder } from '../../src/notifications/undelivered-confirmation-recorder';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const APPT = '00000000-0000-4000-8000-0000000000bb';

function recorder(opts: {
  remindersOff?: boolean;
  phone?: string;
  email?: string;
  status?: string;
}) {
  const dispatchRepo = new InMemoryDispatchRepository();
  const rec = new UndeliveredConfirmationRecorder({
    appointmentRepo: {
      findById: async () =>
        ({ id: APPT, jobId: 'job-1', status: opts.status ?? 'scheduled' }) as never,
    },
    jobRepo: { findById: async () => ({ id: 'job-1', customerId: 'cust-1' }) as never },
    customerRepo: {
      findById: async () =>
        ({ id: 'cust-1', primaryPhone: opts.phone, email: opts.email }) as never,
    },
    settingsRepo: {
      findByTenant: async () =>
        (opts.remindersOff ? { autoSendAppointmentReminders: false } : null) as never,
    },
    dispatchRepo,
  });
  const rows = async () =>
    (await dispatchRepo.listByTenant(TENANT)).dispatches.map((d) => `${d.channel}:${d.status}`);
  return { rec, rows };
}

const request = { tenantId: TENANT, appointmentId: APPT, jobId: 'job-1', channels: ['sms', 'email'] as Array<'sms' | 'email'> };

describe('UndeliveredConfirmationRecorder (#1077)', () => {
  it('records nothing when the owner turned appointment confirmations off', async () => {
    const { rec, rows } = recorder({ remindersOff: true, phone: '+15550000001', email: 'a@example.com' });
    await rec.enqueue(request);
    expect(await rows()).toEqual([]);
  });

  it('records only the channels the customer is reachable on', async () => {
    const { rec, rows } = recorder({ email: 'a@example.com' });
    await rec.enqueue(request);
    expect(await rows()).toEqual(['email:failed']);
  });

  it('records nothing for a canceled appointment', async () => {
    const { rec, rows } = recorder({ status: 'canceled', phone: '+15550000001' });
    await rec.enqueue(request);
    expect(await rows()).toEqual([]);
  });
});
