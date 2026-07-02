/**
 * U2 — create_invoice_schedule voice on-ramp (task-handler level), plus the
 * U1 reassign_appointment resolved-technician consumption (same passthrough
 * family, same fixture helpers).
 */
import { describe, expect, it } from 'vitest';
import {
  CreateInvoiceScheduleTaskHandler,
  ReassignAppointmentTaskHandler,
} from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { assertValidProposalPayload } from '../../../src/proposals/contracts';
import { validateMilestones, InvoiceMilestone } from '../../../src/invoices/invoice-schedule';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

const JOB_ID = '22222222-2222-2222-2222-222222222222';

describe('CreateInvoiceScheduleTaskHandler', () => {
  it('parses the spoken plan into milestones and consumes the resolved jobId', async () => {
    const res = await new CreateInvoiceScheduleTaskHandler().handle(
      ctx({
        message: 'Set up 50% deposit, 50% on completion for the Hendersons',
        existingEntities: {
          jobReference: 'the Hendersons',
          jobId: JOB_ID, // router-resolved (P8 annotation seam)
          scheduleDescription: '50% deposit, 50% on completion',
        },
      }),
    );

    expect(res.proposal.proposalType).toBe('create_invoice_schedule');
    expect(res.proposal.payload.jobId).toBe(JOB_ID);
    const milestones = res.proposal.payload.milestones as InvoiceMilestone[];
    expect(validateMilestones(milestones)).toEqual([]);
    expect(milestones.map((m) => m.type)).toEqual(['percent', 'remainder']);
    expect(missingFieldsFor(res.proposal)).toEqual([]);
    // Complete payload must satisfy the Zod contract the executor validates.
    assertValidProposalPayload('create_invoice_schedule', res.proposal.payload);
    // Capture-class but NO trust tier passed → always drafts for review.
    expect(res.proposal.status).toBe('draft');
  });

  it('unresolved job reference → jobId flagged missing, reference preserved', async () => {
    const res = await new CreateInvoiceScheduleTaskHandler().handle(
      ctx({
        existingEntities: {
          jobReference: 'the Hendersons',
          scheduleDescription: '50% deposit, 50% on completion',
        },
      }),
    );
    expect(res.proposal.payload.jobId).toBeUndefined();
    expect(res.proposal.payload.jobReference).toBe('the Hendersons');
    expect(missingFieldsFor(res.proposal)).toEqual(['jobId']);
    expect(res.proposal.status).toBe('draft');
  });

  it('parser-null plan → milestones flagged missing with the raw sentence preserved', async () => {
    const res = await new CreateInvoiceScheduleTaskHandler().handle(
      ctx({
        existingEntities: {
          jobId: JOB_ID,
          scheduleDescription: 'a third to start, balance on completion',
        },
      }),
    );
    expect(res.proposal.payload.milestones).toBeUndefined();
    // Review UI sees exactly what was said.
    expect(res.proposal.payload.scheduleDescription).toBe(
      'a third to start, balance on completion',
    );
    expect(missingFieldsFor(res.proposal)).toEqual(['milestones']);
    expect(res.proposal.status).toBe('draft');
  });

  it('no schedule sentence at all → milestones missing', async () => {
    const res = await new CreateInvoiceScheduleTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID } }),
    );
    expect(missingFieldsFor(res.proposal)).toEqual(['milestones']);
  });

  it('spoken job total rides totalAmountCents (integer cents); absent → omitted', async () => {
    const withAmount = await new CreateInvoiceScheduleTaskHandler().handle(
      ctx({
        existingEntities: {
          jobId: JOB_ID,
          scheduleDescription: '50% deposit, rest on completion',
          amount: 400000,
        },
      }),
    );
    expect(withAmount.proposal.payload.totalAmountCents).toBe(400000);

    const withoutAmount = await new CreateInvoiceScheduleTaskHandler().handle(
      ctx({
        existingEntities: {
          jobId: JOB_ID,
          scheduleDescription: '50% deposit, rest on completion',
        },
      }),
    );
    expect(withoutAmount.proposal.payload.totalAmountCents).toBeUndefined();
  });
});

// U1 — reassign consumes the router-resolved technician id.
describe('ReassignAppointmentTaskHandler (U1 technician resolution)', () => {
  const TECH_ID = '33333333-3333-3333-3333-333333333333';

  it('resolved technician id lands as toTechnicianId and is NOT flagged missing', async () => {
    const res = await new ReassignAppointmentTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: "Tuesday's Davis job",
          targetTechnicianName: 'Carlos',
          technicianId: TECH_ID,
        },
      }),
    );
    expect(res.proposal.payload.toTechnicianId).toBe(TECH_ID);
    expect(res.proposal.payload.targetTechnicianName).toBe('Carlos');
    // The appointment itself still needs review-time resolution (the
    // execution handler acts only on a concrete appointmentId), but the
    // technician gate is satisfied by the verified id.
    expect(missingFieldsFor(res.proposal)).toEqual(['appointmentId']);
    expect(res.proposal.status).toBe('draft');
  });

  it('unresolved technician name keeps the legacy missing-marker', async () => {
    const res = await new ReassignAppointmentTaskHandler().handle(
      ctx({
        existingEntities: {
          appointmentReference: "Tuesday's Davis job",
          targetTechnicianName: 'Carlos',
        },
      }),
    );
    expect(res.proposal.payload.toTechnicianId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toEqual(['appointmentId', 'toTechnicianId']);
  });

  it('no appointment reference at all still flags appointmentId', async () => {
    const res = await new ReassignAppointmentTaskHandler().handle(
      ctx({ existingEntities: { technicianId: TECH_ID } }),
    );
    expect(missingFieldsFor(res.proposal)).toEqual(['appointmentId']);
    expect(res.proposal.payload.toTechnicianId).toBe(TECH_ID);
  });
});
