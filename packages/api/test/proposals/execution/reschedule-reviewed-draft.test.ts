/**
 * #432 — when an approved tech-out reschedule carries the owner-reviewed
 * brand-voice SMS on `sourceContext.draftSms`, THAT message is what the
 * customer receives (with the newly chosen time appended), not the generic
 * notifyRescheduled template. Proposals without a draft keep the template.
 *
 * Seam: RescheduleAppointmentExecutionHandler.execute → the SMS the real
 * TransactionalCommsService hands to the delivery provider.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { RescheduleAppointmentExecutionHandler } from '../../../src/proposals/execution/reschedule-handler';
import type { Proposal } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import { createAppointment } from '../../../src/appointments/appointment';
import { TransactionalCommsService } from '../../../src/notifications/transactional-comms-service';
import { InMemoryDeliveryProvider } from '../../../src/notifications/delivery-provider';
import { InMemoryDispatchRepository } from '../../../src/notifications/dispatch-repository';
import { InMemoryDncRepository } from '../../../src/compliance/dnc';
import { InMemoryCustomerRepository } from '../../../src/customers/customer';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemorySettingsRepository } from '../../../src/settings/settings';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { createLogger } from '../../../src/logging/logger';

// The fixtures below are literal 2026 instants. #1402 refuses to book or move a visit to a start in the past, so pin
// the wall clock before every fixture slot — these tests describe behaviour at
// a fixed clock, not at whatever day CI happens to run.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const TENANT = 'tenant-432';
const DRAFT = "Hi Sam, your tech is out sick today — sorry! We've moved your visit.";

describe('#432 — approved reschedule sends the owner-reviewed draftSms', () => {
  let appointmentRepo: InMemoryAppointmentRepository;
  let delivery: InMemoryDeliveryProvider;
  let auditRepo: InMemoryAuditRepository;
  let handler: RescheduleAppointmentExecutionHandler;
  let appointmentId: string;

  beforeEach(async () => {
    appointmentRepo = new InMemoryAppointmentRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const customerId = uuidv4();
    await customerRepo.create({
      id: customerId,
      tenantId: TENANT,
      firstName: 'Sam',
      lastName: 'Lee',
      displayName: 'Sam Lee',
      primaryPhone: '+15550000432',
      smsConsent: true,
      isArchived: false,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobRepo = new InMemoryJobRepository();
    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId: TENANT,
      customerId,
      locationId: uuidv4(),
      jobNumber: 'JOB-432',
      summary: 'Tune-up',
      status: 'scheduled',
      priority: 'normal',
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const appt = await createAppointment(
      {
        tenantId: TENANT,
        jobId,
        scheduledStart: new Date('2026-03-14T14:00:00Z'),
        scheduledEnd: new Date('2026-03-14T16:00:00Z'),
        timezone: 'UTC',
        createdBy: 'u1',
      },
      appointmentRepo,
    );
    appointmentId = appt.id;

    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create({
      id: uuidv4(),
      tenantId: TENANT,
      businessName: 'Acme HVAC',
      timezone: 'UTC',
      estimatePrefix: 'E-',
      invoicePrefix: 'I-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      autoSendAppointmentReminders: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    delivery = new InMemoryDeliveryProvider();
    auditRepo = new InMemoryAuditRepository();
    const comms = new TransactionalCommsService({
      delivery,
      dispatchRepo: new InMemoryDispatchRepository(),
      dncRepo: new InMemoryDncRepository(),
      appointmentRepo,
      jobRepo,
      customerRepo,
      settingsRepo,
      invoiceRepo: new InMemoryInvoiceRepository(),
      pool: null,
      logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
    });
    handler = new RescheduleAppointmentExecutionHandler(
      appointmentRepo, undefined, undefined, auditRepo, undefined, comms,
    );
  });

  function proposal(sourceContext?: Record<string, unknown>): Proposal {
    return {
      id: 'prop-432',
      tenantId: TENANT,
      proposalType: 'reschedule_appointment',
      status: 'approved',
      payload: {
        appointmentId,
        newScheduledStart: '2026-03-16T15:00:00Z',
        newScheduledEnd: '2026-03-16T17:00:00Z',
      },
      summary: 'Reschedule',
      createdBy: 'system',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...(sourceContext ? { sourceContext } : {}),
    };
  }

  it('sends the reviewed draft with the chosen new time, not the generic template', async () => {
    const result = await handler.execute(
      proposal({ draftSms: DRAFT, requiresSlotSelection: true }),
      { tenantId: TENANT, executedBy: 'owner-1' },
    );
    expect(result.success).toBe(true);
    expect(delivery.sentSms).toHaveLength(1);
    const body = delivery.sentSms[0].body;
    expect(body.startsWith(DRAFT)).toBe(true);
    // The chosen slot (Monday March 16, 3:00 PM UTC) is interpolated at send.
    expect(body).toMatch(/New date & time: .*March 16.*3:00/);
    // Not the generic reschedule opener.
    expect(body).not.toMatch(/has been rescheduled/i);
  });

  it('records on the audit event which customer message was sent', async () => {
    await handler.execute(proposal({ draftSms: DRAFT }), { tenantId: TENANT, executedBy: 'owner-1' });
    const [event] = await auditRepo.findByEntity(TENANT, 'appointment', appointmentId);
    expect(event.eventType).toBe('appointment.rescheduled');
    expect(event.metadata?.customerMessage).toBe('reviewed_draft');
  });

  it('a reschedule without a draft keeps the generic template (and audits it)', async () => {
    const result = await handler.execute(proposal(), { tenantId: TENANT, executedBy: 'owner-1' });
    expect(result.success).toBe(true);
    expect(delivery.sentSms[0].body).toMatch(/has been rescheduled/i);
    const [event] = await auditRepo.findByEntity(TENANT, 'appointment', appointmentId);
    expect(event.metadata?.customerMessage).toBe('template');
  });
});
