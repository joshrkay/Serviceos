/**
 * Full-app voice coverage — task handlers + execution for the new
 * update_customer / log_expense / convert_lead intents.
 *
 * These mirror the existing voice-extended-tasks pattern: the handler
 * is a passthrough from the classifier's ExtractedEntities to a typed
 * proposal payload, flagging missing fields so a partial payload can
 * never auto-execute.
 */
import { describe, it, expect } from 'vitest';
import {
  UpdateCustomerTaskHandler,
  LogExpenseTaskHandler,
  ConvertLeadTaskHandler,
  ConfirmAppointmentTaskHandler,
  MarkLeadLostTaskHandler,
  AddServiceLocationTaskHandler,
  LogTimeEntryTaskHandler,
  NotifyDelayTaskHandler,
  RequestFeedbackTaskHandler,
  RescheduleAppointmentTaskHandler,
  CancelAppointmentTaskHandler,
} from '../../../src/ai/tasks/voice-extended-tasks';
import type { AppointmentRepository } from '../../../src/appointments/appointment';
import type { JobRepository } from '../../../src/jobs/job';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { ConvertLeadExecutionHandler } from '../../../src/proposals/execution/convert-lead-handler';
import { NotifyDelayExecutionHandler } from '../../../src/proposals/execution/full-app-voice-handlers';
import { Proposal, ProposalType, missingFieldsFor } from '../../../src/proposals/proposal';
import { InMemoryLeadRepository } from '../../../src/leads/lead';
import { InMemoryCustomerRepository } from '../../../src/customers/customer';
import { createLead } from '../../../src/leads/lead-service';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'u-1',
    message: 'test transcript',
    ...overrides,
  };
}

describe('UpdateCustomerTaskHandler', () => {
  it('uses the identified caller id and maps updated fields onto the payload', async () => {
    const res = await new UpdateCustomerTaskHandler().handle(
      ctx({
        customerId: 'cust-9',
        existingEntities: { updatedPhone: '+15555550143' },
      }),
    );
    expect(res.proposal.proposalType).toBe('update_customer');
    expect(res.proposal.payload.customerId).toBe('cust-9');
    expect(res.proposal.payload.phone).toBe('+15555550143');
    expect(missingFieldsFor(res.proposal)).not.toContain('customerId');
  });

  it('flags customerId missing on the operator path (no caller identity)', async () => {
    const res = await new UpdateCustomerTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Sarah', updatedEmail: 'a@b.co' } }),
    );
    expect(res.proposal.payload.customerReference).toBe('Sarah');
    expect(missingFieldsFor(res.proposal)).toContain('customerId');
  });

  it('flags an absent change as a missing updatedField', async () => {
    const res = await new UpdateCustomerTaskHandler().handle(
      ctx({ customerId: 'cust-9', existingEntities: {} }),
    );
    expect(missingFieldsFor(res.proposal)).toContain('updatedField');
  });
});

describe('LogExpenseTaskHandler', () => {
  it('maps amount, category and vendor; defaults spentAt to today', async () => {
    const res = await new LogExpenseTaskHandler().handle(
      ctx({
        existingEntities: {
          amount: 24000,
          expenseCategory: 'materials',
          vendor: 'Supply House',
          expenseDescription: 'water heater parts',
        },
      }),
    );
    expect(res.proposal.proposalType).toBe('log_expense');
    expect(res.proposal.payload.amountCents).toBe(24000);
    expect(res.proposal.payload.category).toBe('materials');
    expect(res.proposal.payload.vendor).toBe('Supply House');
    expect(res.proposal.payload.spentAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(missingFieldsFor(res.proposal)).not.toContain('amountCents');
  });

  it('flags amountCents missing and defaults category to other', async () => {
    const res = await new LogExpenseTaskHandler().handle(
      ctx({ existingEntities: {} }),
    );
    expect(res.proposal.payload.category).toBe('other');
    expect(missingFieldsFor(res.proposal)).toContain('amountCents');
  });
});

describe('ConvertLeadTaskHandler', () => {
  it('carries the lead reference and always flags leadId missing', async () => {
    const res = await new ConvertLeadTaskHandler().handle(
      ctx({ existingEntities: { leadReference: 'the Johnson lead' } }),
    );
    expect(res.proposal.proposalType).toBe('convert_lead');
    expect(res.proposal.payload.leadReference).toBe('the Johnson lead');
    expect(missingFieldsFor(res.proposal)).toContain('leadId');
  });
});

describe('wave-2 task handlers', () => {
  it('confirm_appointment resolves the single active appointment when a repo is wired', async () => {
    const repo = {
      listWithMeta: async () => ({ data: [{ id: 'appt-1', status: 'scheduled' }] }),
    } as unknown as import('../../../src/appointments/appointment').AppointmentRepository;
    const res = await new ConfirmAppointmentTaskHandler(repo).handle(ctx({}));
    expect(res.proposal.proposalType).toBe('confirm_appointment');
    expect(res.proposal.payload.appointmentId).toBe('appt-1');
    expect(missingFieldsFor(res.proposal)).not.toContain('appointmentId');
  });

  it('mark_lead_lost carries reason + reference and flags leadId missing', async () => {
    const res = await new MarkLeadLostTaskHandler().handle(
      ctx({ message: 'lost it', existingEntities: { leadReference: 'the Davis lead', lostReason: 'price' } }),
    );
    expect(res.proposal.proposalType).toBe('mark_lead_lost');
    expect(res.proposal.payload.leadReference).toBe('the Davis lead');
    expect(res.proposal.payload.reason).toBe('price');
    expect(missingFieldsFor(res.proposal)).toContain('leadId');
  });

  it('add_service_location requires structured address resolution', async () => {
    const res = await new AddServiceLocationTaskHandler().handle(
      ctx({ customerId: 'cust-1', existingEntities: { serviceAddress: '412 Oak St' } }),
    );
    expect(res.proposal.proposalType).toBe('add_service_location');
    expect(res.proposal.payload.addressText).toBe('412 Oak St');
    const missing = missingFieldsFor(res.proposal);
    expect(missing).toContain('street1');
    expect(missing).toContain('postalCode');
  });

  it('log_time_entry defaults entryType to job', async () => {
    const res = await new LogTimeEntryTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(res.proposal.proposalType).toBe('log_time_entry');
    expect(res.proposal.payload.entryType).toBe('job');
  });

  it('notify_delay carries delay minutes and flags appointmentId when unresolved', async () => {
    const res = await new NotifyDelayTaskHandler().handle(
      ctx({ existingEntities: { appointmentReference: 'the 10am', delayMinutes: 30 } }),
    );
    expect(res.proposal.proposalType).toBe('notify_delay');
    expect(res.proposal.payload.delayMinutes).toBe(30);
    expect(missingFieldsFor(res.proposal)).toContain('appointmentId');
  });

  it('request_feedback carries the job reference', async () => {
    const res = await new RequestFeedbackTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Johnson job' } }),
    );
    expect(res.proposal.proposalType).toBe('request_feedback');
    expect(res.proposal.payload.jobReference).toBe('the Johnson job');
  });
});

function approved(proposalType: ProposalType, payload: Record<string, unknown>): Proposal {
  const now = new Date();
  return {
    id: 'p-1',
    tenantId: 't-1',
    proposalType,
    status: 'approved',
    payload,
    summary: 'test',
    createdBy: 'u-1',
    createdAt: now,
    updatedAt: now,
  };
}

describe('NotifyDelayExecutionHandler', () => {
  it('resolves appointment→job→customer and sends a delay notice', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const delayService = {
      sendDelayNotice: async (req: Record<string, unknown>) => {
        sent.push(req);
        return { providerMessageId: 'msg-1' };
      },
    };
    const appointmentRepo = {
      findById: async () => ({ id: 'appt-1', jobId: 'job-1' }),
    } as unknown as import('../../../src/appointments/appointment').AppointmentRepository;
    const jobRepo = {
      findById: async () => ({ id: 'job-1', customerId: 'cust-1' }),
    } as unknown as import('../../../src/jobs/job').JobRepository;
    const customerRepo = {
      findById: async () => ({
        id: 'cust-1',
        displayName: 'Jane Smith',
        preferredChannel: 'sms',
        smsConsent: true,
        primaryPhone: '+15555550143',
      }),
    } as unknown as import('../../../src/customers/customer').CustomerRepository;

    const handler = new NotifyDelayExecutionHandler(
      delayService as unknown as import('../../../src/notifications/delay-notifications').DelayNotificationService,
      appointmentRepo,
      jobRepo,
      customerRepo,
    );
    const res = await handler.execute(approved('notify_delay', { appointmentId: 'appt-1', delayMinutes: 30 }), {
      tenantId: 't-1',
      executedBy: 'u-1',
    });
    expect(res.success).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe('sms');
    expect(sent[0].destination).toBe('+15555550143');
    expect(typeof sent[0].message).toBe('string');
    expect((sent[0].message as string).length).toBeGreaterThan(0);
  });

  it('degrades to passthrough success when deps are absent', async () => {
    const res = await new NotifyDelayExecutionHandler().execute(
      approved('notify_delay', { appointmentId: 'appt-1' }),
      { tenantId: 't-1', executedBy: 'u-1' },
    );
    expect(res.success).toBe(true);
  });
});

describe('ConvertLeadExecutionHandler', () => {
  it('rejects when leadId is unresolved', async () => {
    const handler = new ConvertLeadExecutionHandler();
    const res = await handler.execute(approved('convert_lead', { leadReference: 'x' }), {
      tenantId: 't-1',
      executedBy: 'u-1',
    });
    expect(res.success).toBe(false);
  });

  it('converts a real lead into a customer via the shared service', async () => {
    const leadRepo = new InMemoryLeadRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const lead = await createLead(
      {
        tenantId: 't-1',
        firstName: 'Jane',
        lastName: 'Smith',
        primaryPhone: '+15555550100',
        source: 'phone_call',
        createdBy: 'u-1',
      },
      leadRepo,
    );

    const handler = new ConvertLeadExecutionHandler(leadRepo, customerRepo);
    const res = await handler.execute(approved('convert_lead', { leadId: lead.id }), {
      tenantId: 't-1',
      executedBy: 'u-1',
    });

    expect(res.success).toBe(true);
    expect(res.resultEntityId).toBeDefined();
    const refreshed = await leadRepo.findById('t-1', lead.id);
    expect(refreshed?.convertedCustomerId).toBe(res.resultEntityId);
  });
});

describe('caller-scoped appointment resolution (reschedule/cancel/confirm)', () => {
  const SOON = new Date(Date.now() + 24 * 60 * 60 * 1000); // upcoming

  // Two upcoming appointments belonging to two different customers. A
  // tenant-wide single-active scan would be ambiguous (2 active); the
  // caller-scoped resolver must pick only the caller's own appointment.
  function twoCustomerRepos(): { apptRepo: AppointmentRepository; jobRepo: JobRepository } {
    const apptRepo = {
      listWithMeta: async () => ({
        data: [
          { id: 'appt-A', jobId: 'job-A', status: 'scheduled', scheduledStart: SOON },
          { id: 'appt-B', jobId: 'job-B', status: 'scheduled', scheduledStart: SOON },
        ],
      }),
    } as unknown as AppointmentRepository;
    const jobRepo = {
      findById: async (_t: string, id: string) =>
        id === 'job-A'
          ? { id: 'job-A', customerId: 'cust-A' }
          : id === 'job-B'
            ? { id: 'job-B', customerId: 'cust-B' }
            : null,
    } as unknown as JobRepository;
    return { apptRepo, jobRepo };
  }

  it('reschedule resolves the CALLER\'s own appointment, never another customer\'s', async () => {
    const { apptRepo, jobRepo } = twoCustomerRepos();
    const res = await new RescheduleAppointmentTaskHandler(undefined, apptRepo, jobRepo).handle(
      ctx({ customerId: 'cust-A', existingEntities: { newDateTimeDescription: 'next Tue 2pm' } }),
    );
    expect(res.proposal.payload.appointmentId).toBe('appt-A');
    expect(missingFieldsFor(res.proposal)).not.toContain('appointmentId');
  });

  it('cancel resolves the caller\'s own appointment', async () => {
    const { apptRepo, jobRepo } = twoCustomerRepos();
    const res = await new CancelAppointmentTaskHandler(apptRepo, jobRepo).handle(
      ctx({ customerId: 'cust-B' }),
    );
    expect(res.proposal.payload.appointmentId).toBe('appt-B');
  });

  it('leaves appointmentId missing when the caller has >1 upcoming appointment (ambiguous)', async () => {
    const apptRepo = {
      listWithMeta: async () => ({
        data: [
          { id: 'appt-A1', jobId: 'job-A', status: 'scheduled', scheduledStart: SOON },
          { id: 'appt-A2', jobId: 'job-A', status: 'scheduled', scheduledStart: SOON },
        ],
      }),
    } as unknown as AppointmentRepository;
    const jobRepo = {
      findById: async () => ({ id: 'job-A', customerId: 'cust-A' }),
    } as unknown as JobRepository;
    const res = await new ConfirmAppointmentTaskHandler(apptRepo, jobRepo).handle(
      ctx({ customerId: 'cust-A' }),
    );
    expect(res.proposal.payload.appointmentId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toContain('appointmentId');
  });
});
