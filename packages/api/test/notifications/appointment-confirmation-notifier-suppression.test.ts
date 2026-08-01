import { describe, expect, it, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { AppointmentConfirmationNotifier } from '../../src/notifications/appointment-confirmation-notifier';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryCustomerRepository, Customer } from '../../src/customers/customer';
import { InMemoryJobRepository, Job } from '../../src/jobs/job';
import {
  InMemoryAppointmentRepository,
  Appointment,
} from '../../src/appointments/appointment';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';

const TENANT = 'tenant-conf-1';

function makeCustomer(o: Partial<Customer> = {}): Customer {
  return {
    id: o.id ?? uuidv4(),
    tenantId: TENANT,
    firstName: 'Alex',
    lastName: 'Park',
    displayName: 'Alex Park',
    primaryPhone: '+15557654321',
    email: 'alex@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...o,
  };
}

function makeJob(customerId: string): Job {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    customerId,
    locationId: 'loc-1',
    jobNumber: 'JOB-100',
    summary: 'HVAC tune-up',
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeAppointment(jobId: string): Appointment {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    jobId,
    scheduledStart: new Date('2026-06-01T17:00:00Z'),
    scheduledEnd: new Date('2026-06-01T18:00:00Z'),
    timezone: 'America/Los_Angeles',
    status: 'scheduled',
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface Harness {
  notifier: AppointmentConfirmationNotifier;
  delivery: InMemoryDeliveryProvider;
  dispatch: InMemoryDispatchRepository;
  customer: InMemoryCustomerRepository;
  job: InMemoryJobRepository;
  appointment: InMemoryAppointmentRepository;
  settings: InMemorySettingsRepository;
  dnc: InMemoryDncRepository;
}

async function buildHarness(): Promise<Harness> {
  const customer = new InMemoryCustomerRepository();
  const job = new InMemoryJobRepository();
  const appointment = new InMemoryAppointmentRepository();
  const settings = new InMemorySettingsRepository();
  const dispatch = new InMemoryDispatchRepository();
  const delivery = new InMemoryDeliveryProvider();
  const dnc = new InMemoryDncRepository();

  await settings.create({
    id: uuidv4(),
    tenantId: TENANT,
    businessName: 'Acme HVAC',
    timezone: 'America/Los_Angeles',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1000,
    nextInvoiceNumber: 2000,
    defaultPaymentTermDays: 30,
    autoSendAppointmentReminders: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // WS1 — consent/DNC gate now lives in the delivery wrapper (enforcement 'block').
  const gated = new GatedMessageDelivery({
    base: delivery,
    dnc,
    auditRepo: new InMemoryAuditRepository(),
    enforcement: 'block',
  });
  const notifier = new AppointmentConfirmationNotifier({
    delivery: gated,
    appointmentRepo: appointment,
    jobRepo: job,
    customerRepo: customer,
    settingsRepo: settings,
    dispatchRepo: dispatch,
  });

  return { notifier, delivery, dispatch, customer, job, appointment, settings, dnc };
}

describe('AppointmentConfirmationNotifier suppression (§7 phase 1)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it('skips SMS when the recipient is on the tenant DNC list (email still sends)', async () => {
    const c = makeCustomer({ primaryPhone: '+15551234567', smsConsent: true });
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const appt = makeAppointment(j.id);
    await h.appointment.create(appt);
    h.dnc.add(TENANT, normalizePhone('+15551234567'));

    await h.notifier.enqueue({
      tenantId: TENANT,
      appointmentId: appt.id,
      jobId: j.id,
      channels: ['sms', 'email'],
    });

    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(1);
  });

  it('skips SMS when sms_consent is false (email still sends)', async () => {
    const c = makeCustomer({ smsConsent: false });
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const appt = makeAppointment(j.id);
    await h.appointment.create(appt);

    await h.notifier.enqueue({
      tenantId: TENANT,
      appointmentId: appt.id,
      jobId: j.id,
      channels: ['sms', 'email'],
    });

    expect(h.delivery.sentSms).toHaveLength(0);
    expect(h.delivery.sentEmails).toHaveLength(1);
  });

  it('sends SMS when consent + DNC clear', async () => {
    const c = makeCustomer({ smsConsent: true });
    await h.customer.create(c);
    const j = makeJob(c.id);
    await h.job.create(j);
    const appt = makeAppointment(j.id);
    await h.appointment.create(appt);

    await h.notifier.enqueue({
      tenantId: TENANT,
      appointmentId: appt.id,
      jobId: j.id,
      channels: ['sms'],
    });

    expect(h.delivery.sentSms).toHaveLength(1);
  });
});
