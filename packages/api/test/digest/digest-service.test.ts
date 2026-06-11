import { describe, it, expect } from 'vitest';
import {
  computeDigestPayload,
  buildFallbackNarrative,
  renderDigestSms,
  summarizeProposalForDigest,
  upsertDigest,
  localDateString,
  nextDateString,
  formatUsd,
  InMemoryDailyDigestRepository,
  DIGEST_SMS_MAX_CHARS,
  type DailyDigestPayload,
  type DigestComputeDeps,
} from '../../src/digest/digest-service';
import type { Payment, PaymentRepository } from '../../src/invoices/payment';
import type { Invoice, InvoiceRepository } from '../../src/invoices/invoice';
import type { EstimateRepository, Estimate } from '../../src/estimates/estimate';
import type { Job, JobRepository } from '../../src/jobs/job';
import type { Appointment, AppointmentRepository } from '../../src/appointments/appointment';
import type { Proposal, ProposalRepository } from '../../src/proposals/proposal';
import type { CustomerRepository } from '../../src/customers/customer';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const TENANT = 'tenant-1';
const TZ = 'America/Chicago';
// 2026-06-10 in America/Chicago (CDT, UTC-5): day window is
// [2026-06-10T05:00:00Z, 2026-06-11T05:00:00Z).
const DATE = '2026-06-10';
const NOW = new Date('2026-06-11T01:00:00Z'); // 2026-06-10 20:00 local

function payment(overrides: Partial<Payment>): Payment {
  return {
    id: `pay-${Math.random()}`,
    tenantId: TENANT,
    invoiceId: 'inv-1',
    amountCents: 10000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: new Date('2026-06-10T17:00:00Z'),
    processedBy: 'u1',
    createdAt: NOW,
    updatedAt: NOW,
    refundedAmountCents: 0,
    ...overrides,
  } as Payment;
}

function settingsRow(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    id: 's1',
    tenantId: TENANT,
    businessName: 'ACME HVAC',
    timezone: TZ,
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface DepsOverrides {
  payments?: Payment[];
  completedJobs?: Job[];
  appointments?: Appointment[];
  openInvoices?: Invoice[];
  partiallyPaidInvoices?: Invoice[];
  pendingProposals?: Proposal[];
  estimatesByJob?: Estimate[];
  invoicesByJob?: Invoice[];
  customerNames?: Record<string, string>;
  settings?: TenantSettings | null;
}

function makeDeps(o: DepsOverrides = {}): DigestComputeDeps {
  return {
    paymentRepo: {
      findByTenant: async () => o.payments ?? [],
    } as unknown as PaymentRepository,
    jobRepo: {
      findByTenant: async () => o.completedJobs ?? [],
    } as unknown as JobRepository,
    appointmentRepo: {
      findByDateRange: async () => o.appointments ?? [],
    } as unknown as AppointmentRepository,
    invoiceRepo: {
      findByTenant: async (_t: string, opts?: { status?: string }) =>
        opts?.status === 'open'
          ? o.openInvoices ?? []
          : o.partiallyPaidInvoices ?? [],
      findByJobs: async () => o.invoicesByJob ?? [],
    } as unknown as InvoiceRepository,
    estimateRepo: {
      findByJobs: async () => o.estimatesByJob ?? [],
    } as unknown as EstimateRepository,
    proposalRepo: {
      findByStatus: async () => o.pendingProposals ?? [],
    } as unknown as ProposalRepository,
    customerRepo: {
      findById: async (_t: string, id: string) =>
        o.customerNames?.[id] !== undefined
          ? { id, displayName: o.customerNames[id] }
          : null,
    } as unknown as CustomerRepository,
    settingsRepo: {
      findByTenant: async () =>
        o.settings === undefined ? settingsRow() : o.settings,
    } as unknown as SettingsRepository,
    now: () => NOW,
  };
}

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    id: `prop-${Math.random()}`,
    tenantId: TENANT,
    proposalType: 'draft_estimate',
    status: 'ready_for_review',
    payload: {},
    summary: 'A proposal',
    createdBy: 'ai',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Proposal;
}

describe('computeDigestPayload', () => {
  it('buckets payments by tenant-timezone day boundaries (late-evening local payment counts; next-local-day payment does not)', async () => {
    const inWindowLate = payment({
      // 2026-06-11T03:30Z = 2026-06-10 22:30 in Chicago — inside the day.
      receivedAt: new Date('2026-06-11T03:30:00Z'),
      amountCents: 5000,
    });
    const outOfWindow = payment({
      // 2026-06-11T05:30Z = 2026-06-11 00:30 in Chicago — next local day.
      receivedAt: new Date('2026-06-11T05:30:00Z'),
      amountCents: 7000,
    });
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({
      payments: [inWindowLate, outOfWindow],
    }));
    expect(result.revenueCents).toBe(5000);
    expect(result.paymentsCount).toBe(1);
    expect(result.date).toBe(DATE);
    expect(result.timezone).toBe(TZ);
  });

  it('subtracts refunds dated today even when the payment was received earlier (dashboard refund semantics)', async () => {
    const refundedToday = payment({
      receivedAt: new Date('2026-05-20T12:00:00Z'), // outside today
      amountCents: 20000,
      refundedAmountCents: 2500,
      refundedAt: new Date('2026-06-10T18:00:00Z'), // inside today
    } as Partial<Payment>);
    const receivedToday = payment({ amountCents: 10000 });
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({
      payments: [refundedToday, receivedToday],
    }));
    expect(result.grossRevenueCents).toBe(10000);
    expect(result.refundsCents).toBe(2500);
    expect(result.revenueCents).toBe(7500);
  });

  it('counts jobs completed today, tomorrow appointments + first start, pending proposals top-3, and overdue invoices', async () => {
    const completedToday = {
      id: 'job-1',
      tenantId: TENANT,
      customerId: 'c1',
      status: 'completed',
      moneyState: 'invoiced',
      updatedAt: new Date('2026-06-10T16:00:00Z'),
    } as unknown as Job;
    const completedLastWeek = {
      id: 'job-2',
      tenantId: TENANT,
      customerId: 'c1',
      status: 'completed',
      moneyState: 'invoiced',
      updatedAt: new Date('2026-06-03T16:00:00Z'),
    } as unknown as Job;

    const apptEarly = {
      id: 'a1',
      scheduledStart: new Date('2026-06-11T13:00:00Z'), // 8:00 local
      status: 'scheduled',
    } as unknown as Appointment;
    const apptLater = {
      id: 'a2',
      scheduledStart: new Date('2026-06-11T15:00:00Z'),
      status: 'confirmed',
    } as unknown as Appointment;
    const apptCanceled = {
      id: 'a3',
      scheduledStart: new Date('2026-06-11T12:00:00Z'),
      status: 'canceled',
    } as unknown as Appointment;

    const overdue = {
      id: 'inv-overdue',
      status: 'open',
      amountDueCents: 5000,
      dueDate: new Date('2026-06-01T00:00:00Z'),
      jobId: 'job-9',
    } as unknown as Invoice;
    const notYetDue = {
      id: 'inv-future',
      status: 'open',
      amountDueCents: 9000,
      dueDate: new Date('2026-07-01T00:00:00Z'),
      jobId: 'job-9',
    } as unknown as Invoice;

    const proposals = [
      proposal({ id: 'p1', proposalType: 'draft_estimate', summary: 'Estimate for Lopez', payload: { totals: { totalCents: 45000 }, customerName: 'Lopez' } }),
      proposal({ id: 'p2', proposalType: 'send_invoice', summary: 'Send invoice', payload: { totalCents: 12000 } }),
      proposal({ id: 'p3', proposalType: 'add_note', summary: 'Note' }),
      proposal({ id: 'p4', proposalType: 'create_customer', summary: 'New customer' }),
    ];

    const result = await computeDigestPayload(TENANT, DATE, makeDeps({
      completedJobs: [completedToday, completedLastWeek],
      appointments: [apptEarly, apptLater, apptCanceled],
      openInvoices: [overdue, notYetDue],
      pendingProposals: proposals,
    }));

    expect(result.jobsCompletedCount).toBe(1);
    expect(result.tomorrow.appointmentCount).toBe(2);
    expect(result.tomorrow.firstStartIso).toBe('2026-06-11T13:00:00.000Z');
    expect(result.pendingApprovals.totalCount).toBe(4);
    expect(result.pendingApprovals.top).toHaveLength(3);
    // Priority order surfaces money/doc work first.
    expect(result.pendingApprovals.top[0].proposalId).toBe('p1');
    expect(result.pendingApprovals.top[0].amountCents).toBe(45000);
    expect(result.pendingApprovals.top[0].customerName).toBe('Lopez');
    expect(result.overdueInvoicesCount).toBe(1);
  });

  it('lists completed-unbilled jobs (same query as the batch-invoice sweep) with customer names', async () => {
    const items = [buildLineItem('li1', 'Labor', 1, 30000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(items, 0, 0);
    const unbilledJob = {
      id: 'job-u1',
      tenantId: TENANT,
      customerId: 'cust-1',
      status: 'completed',
      moneyState: 'estimate_accepted',
      updatedAt: new Date('2026-06-10T15:00:00Z'),
    } as unknown as Job;
    const acceptedEstimate = {
      id: 'est-1',
      jobId: 'job-u1',
      status: 'accepted',
      lineItems: items,
      totals,
    } as unknown as Estimate;

    const result = await computeDigestPayload(TENANT, DATE, makeDeps({
      completedJobs: [unbilledJob],
      estimatesByJob: [acceptedEstimate],
      invoicesByJob: [],
      customerNames: { 'cust-1': 'Maria Lopez' },
    }));

    expect(result.unbilledJobs).toHaveLength(1);
    expect(result.unbilledJobs[0]).toMatchObject({
      jobId: 'job-u1',
      customerId: 'cust-1',
      customerName: 'Maria Lopez',
      amountCents: 30000,
    });
  });

  it('falls back to America/New_York when the tenant has no settings row', async () => {
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({ settings: null }));
    expect(result.timezone).toBe('America/New_York');
    expect(result.revenueCents).toBe(0);
  });
});

describe('summarizeProposalForDigest', () => {
  it('extracts amount from nested totals, flat keys, and tolerates absent data', () => {
    expect(summarizeProposalForDigest(proposal({ payload: { totals: { totalCents: 100 } } })).amountCents).toBe(100);
    expect(summarizeProposalForDigest(proposal({ payload: { amountCents: 200 } })).amountCents).toBe(200);
    expect(summarizeProposalForDigest(proposal({ payload: { totalCents: 300 } })).amountCents).toBe(300);
    expect(summarizeProposalForDigest(proposal({ payload: {} })).amountCents).toBeUndefined();
  });

  it('extracts customer name from payload or sourceContext', () => {
    expect(summarizeProposalForDigest(proposal({ payload: { customerName: 'Bob' } })).customerName).toBe('Bob');
    expect(
      summarizeProposalForDigest(
        proposal({ payload: {}, sourceContext: { customerName: 'Jane' } }),
      ).customerName,
    ).toBe('Jane');
    expect(summarizeProposalForDigest(proposal({ payload: {} })).customerName).toBeUndefined();
  });
});

describe('date helpers', () => {
  it('localDateString renders the tenant-local calendar day', () => {
    // 2026-06-11T03:30Z is still 2026-06-10 in Chicago.
    expect(localDateString(new Date('2026-06-11T03:30:00Z'), TZ)).toBe('2026-06-10');
    expect(localDateString(new Date('2026-06-11T05:30:00Z'), TZ)).toBe('2026-06-11');
  });

  it('nextDateString handles month/year boundaries', () => {
    expect(nextDateString('2026-06-30')).toBe('2026-07-01');
    expect(nextDateString('2026-12-31')).toBe('2027-01-01');
  });

  it('formatUsd renders integer cents without float math', () => {
    expect(formatUsd(45000)).toBe('$450');
    expect(formatUsd(45050)).toBe('$450.50');
    expect(formatUsd(5)).toBe('$0.05');
    expect(formatUsd(0)).toBe('$0');
  });
});

function basePayload(overrides: Partial<DailyDigestPayload> = {}): DailyDigestPayload {
  return {
    date: DATE,
    timezone: TZ,
    revenueCents: 45000,
    grossRevenueCents: 45000,
    refundsCents: 0,
    paymentsCount: 2,
    jobsCompletedCount: 3,
    tomorrow: { appointmentCount: 4, firstStartIso: '2026-06-11T13:00:00.000Z' },
    pendingApprovals: { totalCount: 0, top: [] },
    overdueInvoicesCount: 0,
    unbilledJobs: [],
    ...overrides,
  };
}

describe('buildFallbackNarrative', () => {
  it('is deterministic and covers money, jobs, tomorrow, approvals, and flags', () => {
    const text = buildFallbackNarrative(basePayload({
      pendingApprovals: { totalCount: 2, top: [] },
      overdueInvoicesCount: 1,
      unbilledJobs: [{ jobId: 'j', customerId: 'c', amountCents: 100 }],
    }));
    expect(text).toContain('$450');
    expect(text).toContain('3 jobs');
    expect(text).toContain('4 visits');
    expect(text).toContain('2 approvals are waiting');
    expect(text).toContain('1 overdue invoice');
    expect(text).toContain('1 completed job not yet invoiced');
  });

  it('renders a quiet-day form when nothing happened', () => {
    const text = buildFallbackNarrative(basePayload({
      revenueCents: 0,
      grossRevenueCents: 0,
      refundsCents: 0,
      paymentsCount: 0,
      jobsCompletedCount: 0,
      tomorrow: { appointmentCount: 0, firstStartIso: null },
    }));
    expect(text).toContain('quiet day');
  });
});

describe('renderDigestSms', () => {
  const longUrl = (i: number) =>
    `https://api.example.com/public/proposals/one-tap-approve?token=${'x'.repeat(160)}${i}`;

  it('includes counts, top approvals with one-tap links, flags, and the digest deep link', () => {
    const payload = basePayload({
      pendingApprovals: {
        totalCount: 3,
        top: [
          { proposalId: 'p1', proposalType: 'draft_estimate', summary: 's', customerName: 'Lopez', amountCents: 45000 },
          { proposalId: 'p2', proposalType: 'send_invoice', summary: 's', amountCents: 12000 },
          { proposalId: 'p3', proposalType: 'add_note', summary: 's' },
        ],
      },
      overdueInvoicesCount: 2,
      unbilledJobs: [{ jobId: 'j', customerId: 'c', amountCents: 100 }],
    });
    const body = renderDigestSms({
      payload,
      deepLinkUrl: 'https://app.example.com/digest/2026-06-10',
      approvalLinks: payload.pendingApprovals.top.map((approval, i) => ({
        approval,
        url: `https://x.co/t${i}`,
      })),
    });
    expect(body.length).toBeLessThanOrEqual(DIGEST_SMS_MAX_CHARS);
    expect(body).toContain('$450 in');
    expect(body).toContain('3 jobs done');
    expect(body).toContain('Tomorrow: 4 visits');
    expect(body).toContain('Approvals: 3 waiting');
    expect(body).toContain('[1] draft estimate $450 Lopez https://x.co/t0');
    expect(body).toContain('https://x.co/t1');
    expect(body).toContain('https://x.co/t2');
    expect(body).toContain('Flags: 2 overdue, 1 unbilled.');
    expect(body).toContain('https://app.example.com/digest/2026-06-10');
  });

  it('never exceeds 480 chars: long one-tap URLs degrade to "+N more" while keeping the deep link', () => {
    const payload = basePayload({
      pendingApprovals: {
        totalCount: 5,
        top: [
          { proposalId: 'p1', proposalType: 'draft_estimate', summary: 's', amountCents: 45000 },
          { proposalId: 'p2', proposalType: 'send_invoice', summary: 's' },
          { proposalId: 'p3', proposalType: 'add_note', summary: 's' },
        ],
      },
    });
    const body = renderDigestSms({
      payload,
      deepLinkUrl: 'https://app.example.com/digest/2026-06-10',
      approvalLinks: payload.pendingApprovals.top.map((approval, i) => ({
        approval,
        url: longUrl(i),
      })),
    });
    expect(body.length).toBeLessThanOrEqual(DIGEST_SMS_MAX_CHARS);
    expect(body).toMatch(/\+\d more/);
    expect(body).toContain('https://app.example.com/digest/2026-06-10');
  });

  it('omits the approvals section entirely when nothing is pending', () => {
    const body = renderDigestSms({
      payload: basePayload(),
      deepLinkUrl: 'https://app.example.com/digest/2026-06-10',
      approvalLinks: [],
    });
    expect(body).not.toContain('Approvals');
    expect(body.length).toBeLessThanOrEqual(DIGEST_SMS_MAX_CHARS);
  });
});

describe('upsertDigest (idempotent storage)', () => {
  it('is idempotent on (tenant, date): a second upsert overwrites in place, preserving id and dispatch state', async () => {
    const repo = new InMemoryDailyDigestRepository();
    const first = await upsertDigest(TENANT, DATE, basePayload(), 'narrative v1', repo);
    await repo.setSmsDispatchId(TENANT, DATE, 'dispatch-1');
    const second = await upsertDigest(
      TENANT,
      DATE,
      basePayload({ revenueCents: 99 }),
      'narrative v2',
      repo,
    );
    expect(second.id).toBe(first.id);
    expect(second.payload.revenueCents).toBe(99);
    expect(second.narrative).toBe('narrative v2');
    expect(second.smsDispatchId).toBe('dispatch-1');
    const stored = await repo.findByTenantAndDate(TENANT, DATE);
    expect(stored?.payload.revenueCents).toBe(99);
  });

  it('insertIfAbsent reports inserted=false on conflict and returns the existing row', async () => {
    const repo = new InMemoryDailyDigestRepository();
    const a = await repo.insertIfAbsent(TENANT, DATE, basePayload(), 'first');
    const b = await repo.insertIfAbsent(TENANT, DATE, basePayload({ revenueCents: 1 }), 'second');
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.digest.id).toBe(a.digest.id);
    expect(b.digest.narrative).toBe('first');
  });

  it('setSmsDispatchId claims only when unset (status-check guard)', async () => {
    const repo = new InMemoryDailyDigestRepository();
    await repo.insertIfAbsent(TENANT, DATE, basePayload());
    const claimed = await repo.setSmsDispatchId(TENANT, DATE, 'd1');
    const second = await repo.setSmsDispatchId(TENANT, DATE, 'd2');
    expect(claimed?.smsDispatchId).toBe('d1');
    expect(second).toBeNull();
    expect((await repo.findByTenantAndDate(TENANT, DATE))?.smsDispatchId).toBe('d1');
  });
});
