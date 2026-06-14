import { describe, it, expect } from 'vitest';
import { gatherDailyDigest, computeDigestWindow, DigestWindow } from '../../../src/notifications/digest/gather';
import { InMemoryJobRepository, Job, JobStatus } from '../../../src/jobs/job';
import { InMemoryPaymentRepository, Payment, PaymentStatus } from '../../../src/invoices/payment';
import { InMemoryInvoiceRepository, Invoice, InvoiceStatus } from '../../../src/invoices/invoice';
import { InMemoryProposalRepository, Proposal, ProposalStatus } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository, Appointment, AppointmentStatus } from '../../../src/appointments/appointment';
import { tzMidnight, addCalendarDays } from '../../../src/shared/timezone';

const TENANT = 't-1';
const TODAY = new Date('2026-06-14T12:00:00Z');
const WINDOW: DigestWindow = {
  todayStart: new Date('2026-06-14T00:00:00Z'),
  todayEnd: new Date('2026-06-15T00:00:00Z'),
  tomorrowEnd: new Date('2026-06-16T00:00:00Z'),
};

let seq = 0;
const id = () => `x-${++seq}`;

function job(status: JobStatus, updatedAt: Date): Job {
  return {
    id: id(), tenantId: TENANT, customerId: 'c', locationId: 'l', jobNumber: 'J', summary: 's',
    status, priority: 'normal', createdBy: 'sys', createdAt: updatedAt, updatedAt,
  };
}

function payment(amountCents: number, status: PaymentStatus, receivedAt: Date, refundedAmountCents = 0): Payment {
  return {
    id: id(), tenantId: TENANT, invoiceId: 'inv', amountCents, method: 'card', status,
    receivedAt, processedBy: 'sys', createdAt: receivedAt, updatedAt: receivedAt,
    refundedAmountCents, refundedAt: null, lastRefundStripeId: null, reversedAt: null, reversalReason: null,
  };
}

function invoice(status: InvoiceStatus, amountDueCents: number, dueDate?: Date): Invoice {
  return {
    id: id(), tenantId: TENANT, jobId: 'j', invoiceNumber: 'INV', status,
    amountDueCents, amountPaidCents: 0, ...(dueDate ? { dueDate } : {}),
    lineItems: [], createdAt: new Date(), updatedAt: new Date(),
  } as unknown as Invoice;
}

function proposal(status: ProposalStatus): Proposal {
  return {
    id: id(), tenantId: TENANT, proposalType: 'draft_invoice', status, payload: {}, summary: 's',
    createdBy: 'sys', createdAt: new Date(), updatedAt: new Date(),
  };
}

function appointment(status: AppointmentStatus, start: Date): Appointment {
  return {
    id: id(), tenantId: TENANT, jobId: 'j', scheduledStart: start, scheduledEnd: start,
    timezone: 'UTC', status, holdPendingApproval: false, createdBy: 'sys',
    createdAt: new Date(), updatedAt: new Date(),
  } as unknown as Appointment;
}

describe('gatherDailyDigest', () => {
  it('aggregates the day across all metric sources', async () => {
    const jobRepo = new InMemoryJobRepository();
    await jobRepo.create(job('completed', new Date('2026-06-14T09:00:00Z')));
    await jobRepo.create(job('completed', new Date('2026-06-14T15:00:00Z')));
    await jobRepo.create(job('completed', new Date('2026-06-13T09:00:00Z'))); // yesterday — excluded
    await jobRepo.create(job('in_progress', new Date('2026-06-14T09:00:00Z'))); // not completed

    const paymentRepo = new InMemoryPaymentRepository();
    await paymentRepo.create(payment(10_000, 'completed', new Date('2026-06-14T10:00:00Z')));
    await paymentRepo.create(payment(5_000, 'completed', new Date('2026-06-14T11:00:00Z'), 1_000)); // net 4000
    await paymentRepo.create(payment(99_900, 'completed', new Date('2026-06-13T10:00:00Z'))); // yesterday
    await paymentRepo.create(payment(2_000, 'pending', new Date('2026-06-14T10:00:00Z'))); // not completed

    const invoiceRepo = new InMemoryInvoiceRepository();
    await invoiceRepo.create(invoice('open', 5_000, new Date('2026-06-10T00:00:00Z'))); // overdue
    await invoiceRepo.create(invoice('partially_paid', 2_000, new Date('2026-06-11T00:00:00Z'))); // overdue
    await invoiceRepo.create(invoice('open', 3_000, new Date('2026-06-30T00:00:00Z'))); // future — not overdue
    await invoiceRepo.create(invoice('paid', 0, new Date('2026-06-01T00:00:00Z'))); // paid — not counted

    const proposalRepo = new InMemoryProposalRepository();
    await proposalRepo.create(proposal('ready_for_review'));
    await proposalRepo.create(proposal('ready_for_review'));
    await proposalRepo.create(proposal('draft'));
    await proposalRepo.create(proposal('approved')); // not pending

    const appointmentRepo = new InMemoryAppointmentRepository();
    await appointmentRepo.create(appointment('scheduled', new Date('2026-06-14T14:00:00Z'))); // today
    await appointmentRepo.create(appointment('confirmed', new Date('2026-06-14T16:00:00Z'))); // today
    await appointmentRepo.create(appointment('canceled', new Date('2026-06-14T17:00:00Z'))); // today, excluded
    await appointmentRepo.create(appointment('scheduled', new Date('2026-06-15T09:00:00Z'))); // tomorrow
    await appointmentRepo.create(appointment('scheduled', new Date('2026-06-15T11:00:00Z'))); // tomorrow
    await appointmentRepo.create(appointment('confirmed', new Date('2026-06-15T13:00:00Z'))); // tomorrow
    await appointmentRepo.create(appointment('no_show', new Date('2026-06-15T15:00:00Z'))); // tomorrow, excluded

    const data = await gatherDailyDigest(TENANT, WINDOW, {
      jobRepo, paymentRepo, invoiceRepo, proposalRepo, appointmentRepo,
    });

    expect(data).toEqual({
      jobsCompleted: 2,
      revenueCents: 14_000,
      pendingApprovals: 3,
      overdueInvoices: 2,
      todayAppointments: 2,
      tomorrowAppointments: 3,
    });
  });

  it('degrades a failing metric to 0 (best-effort, never blocks the digest)', async () => {
    const throwingJobs = {
      findByTenant: async () => {
        throw new Error('db down');
      },
    } as unknown as InMemoryJobRepository;

    const data = await gatherDailyDigest(TENANT, WINDOW, {
      jobRepo: throwingJobs,
      paymentRepo: new InMemoryPaymentRepository(),
      invoiceRepo: new InMemoryInvoiceRepository(),
      proposalRepo: new InMemoryProposalRepository(),
      appointmentRepo: new InMemoryAppointmentRepository(),
    });

    expect(data.jobsCompleted).toBe(0);
    expect(data.revenueCents).toBe(0);
  });
});

describe('computeDigestWindow', () => {
  it('derives tenant-local day boundaries (DST-safe via shared helpers)', () => {
    // 2026-06-14T12:00Z is 08:00 EDT on the 14th in America/New_York.
    const w = computeDigestWindow('America/New_York', TODAY, tzMidnight, addCalendarDays);
    // todayStart = 2026-06-14 00:00 EDT = 04:00Z
    expect(w.todayStart.toISOString()).toBe('2026-06-14T04:00:00.000Z');
    expect(w.todayEnd.toISOString()).toBe('2026-06-15T04:00:00.000Z');
    expect(w.tomorrowEnd.toISOString()).toBe('2026-06-16T04:00:00.000Z');
  });
});
