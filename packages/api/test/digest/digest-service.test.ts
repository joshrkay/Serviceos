import { describe, it, expect } from 'vitest';
import {
  computeDigestPayload,
  buildFallbackNarrative,
  renderDigestSmsSegments,
  summarizeProposalForDigest,
  proposalOutcome,
  upsertDigest,
  localDateString,
  nextDateString,
  formatUsd,
  InMemoryDailyDigestRepository,
  DIGEST_SMS_MAX_CHARS,
  DIGEST_SMS_SOFT_LIMIT,
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
import type { FeedbackResponseRepository, RatingCounts } from '../../src/feedback/feedback-response';
import type { CorrectionLesson, CorrectionLessonRepository } from '../../src/learning/corrections/correction-lesson';
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
  /** 'ready_for_review' proposals (default bucket). */
  pendingProposals?: Proposal[];
  /** 'draft' proposals — treated identically to ready_for_review in the digest. */
  draftProposals?: Proposal[];
  estimatesByJob?: Estimate[];
  invoicesByJob?: Invoice[];
  customerNames?: Record<string, string>;
  settings?: TenantSettings | null;
  ratingCounts?: RatingCounts;
  /** N-005 — estimates returned for the quotes-sent (sentFrom/sentTo) query. */
  sentEstimates?: Estimate[];
  /** N-005 — proposals returned by findConfidenceMarkedForDay. */
  confidenceMarked?: Proposal[];
  /** N-005 — correction lessons applied today. */
  appliedLessons?: CorrectionLesson[];
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
      findByTenant: async () => o.sentEstimates ?? [],
    } as unknown as EstimateRepository,
    proposalRepo: {
      findByStatus: async (_t: string, status: string) =>
        status === 'draft'
          ? o.draftProposals ?? []
          : o.pendingProposals ?? [],
      findConfidenceMarkedForDay: async () => o.confidenceMarked ?? [],
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
    feedbackResponseRepo: {
      countByRatingInRange: async () =>
        o.ratingCounts ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    } as unknown as FeedbackResponseRepository,
    correctionLessonRepo: {
      findAppliedForDay: async () => o.appliedLessons ?? [],
    } as unknown as CorrectionLessonRepository,
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

  it('counts and prioritizes BOTH ready_for_review and draft proposals (inbox parity)', async () => {
    const readyProposal = proposal({ id: 'ready-1', status: 'ready_for_review', proposalType: 'draft_estimate', summary: 'Ready estimate', payload: { totals: { totalCents: 20000 } } });
    const draftVoiceProposal = proposal({ id: 'draft-voice-1', status: 'draft', proposalType: 'voice_clarification', summary: 'Draft voice proposal' });
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({
      pendingProposals: [readyProposal],
      draftProposals: [draftVoiceProposal],
    }));
    // Total must reflect both statuses combined.
    expect(result.pendingApprovals.totalCount).toBe(2);
    // Top includes both (only 2, so all fit).
    const ids = result.pendingApprovals.top.map((a) => a.proposalId);
    expect(ids).toContain('ready-1');
    expect(ids).toContain('draft-voice-1');
  });

  it('falls back to America/New_York when the tenant has no settings row', async () => {
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({ settings: null }));
    expect(result.timezone).toBe('America/New_York');
    expect(result.revenueCents).toBe(0);
  });

  it('summarizes the day\'s feedback (responses, average, low-rating count)', async () => {
    const result = await computeDigestPayload(
      TENANT,
      DATE,
      makeDeps({ ratingCounts: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 3 } }),
    );
    expect(result.feedback).toEqual({ responses: 5, averageRating: 4.2, lowRatingCount: 1 });
  });

  it('reports zero/null feedback on a day with no responses', async () => {
    const result = await computeDigestPayload(TENANT, DATE, makeDeps());
    expect(result.feedback).toEqual({ responses: 0, averageRating: null, lowRatingCount: 0 });
  });

  // ─── N-005 reflection sections ───────────────────────────────────────────

  it('quotesSent sums today\'s sent estimates (count + integer-cents pipeline value)', async () => {
    const sent = (id: string, totalCents: number): Estimate =>
      ({ id, jobId: 'j', status: 'sent', totals: { totalCents }, sentAt: NOW } as unknown as Estimate);
    // Two estimates sent today (one later accepted still counts).
    const accepted = { ...sent('e-acc', 20000), status: 'accepted' } as unknown as Estimate;
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({
      sentEstimates: [sent('e1', 45000), accepted],
    }));
    expect(result.quotesSent).toEqual({ count: 2, pipelineValueCents: 65000 });
  });

  it('omits quotesSent when no estimates were sent today', async () => {
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({ sentEstimates: [] }));
    expect(result.quotesSent).toBeUndefined();
  });

  it('populates "what I wasn\'t sure about" from _meta low-confidence markers with the derived outcome', async () => {
    const veryLowRejected = proposal({
      id: 'unsure-1',
      status: 'rejected',
      proposalType: 'draft_estimate',
      summary: 'Estimate for the Reyes job',
      payload: { _meta: { overallConfidence: 'very_low' } },
      confidenceFactors: ['ambiguous scope', 'uncatalogued line'],
    });
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({ confidenceMarked: [veryLowRejected] }));
    expect(result.unsureAbout).toHaveLength(1);
    expect(result.unsureAbout![0]).toMatchObject({
      proposalId: 'unsure-1',
      proposalType: 'draft_estimate',
      summary: 'Estimate for the Reyes job',
      confidence: 'very_low',
      outcome: 'rejected',
      factors: ['ambiguous scope', 'uncatalogued line'],
    });
  });

  it('omits unsureAbout when no confidence-marked proposals fired today', async () => {
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({ confidenceMarked: [] }));
    expect(result.unsureAbout).toBeUndefined();
  });

  it('populates "what I learned today" from applied correction lessons and omits when none', async () => {
    const lesson: CorrectionLesson = {
      id: 'les-1',
      tenantId: TENANT,
      lessonType: 'labor_rate_changed',
      status: 'applied',
      sourceProposalId: 'p-src',
      ownerId: 'owner',
      summary: 'labor rate is $145 going forward',
      payload: { newRateCents: 14500 } as unknown as CorrectionLesson['payload'],
      localDate: DATE,
      createdAt: NOW,
      revertedAt: null,
    };
    const withLessons = await computeDigestPayload(TENANT, DATE, makeDeps({ appliedLessons: [lesson] }));
    expect(withLessons.learnedToday).toEqual([
      { lessonId: 'les-1', lessonType: 'labor_rate_changed', summary: 'labor rate is $145 going forward' },
    ]);

    const none = await computeDigestPayload(TENANT, DATE, makeDeps({ appliedLessons: [] }));
    expect(none.learnedToday).toBeUndefined();
  });

  it('bad-day simulation (PRD §12): unsureAbout + learnedToday populate together', async () => {
    const veryLow = proposal({
      id: 'p-unsure',
      status: 'rejected',
      payload: { _meta: { overallConfidence: 'very_low' } },
    });
    const lesson: CorrectionLesson = {
      id: 'les-x', tenantId: TENANT, lessonType: 'labor_rate_changed', status: 'applied',
      sourceProposalId: 'p', ownerId: 'o', summary: 'labor rate is $145 going forward',
      payload: {} as unknown as CorrectionLesson['payload'], localDate: DATE, createdAt: NOW, revertedAt: null,
    };
    const result = await computeDigestPayload(TENANT, DATE, makeDeps({
      confidenceMarked: [veryLow],
      appliedLessons: [lesson],
    }));
    expect(result.unsureAbout?.[0]).toMatchObject({ proposalId: 'p-unsure', outcome: 'rejected' });
    expect(result.learnedToday?.[0].summary).toBe('labor rate is $145 going forward');
  });

  it('unsureAbout.outcome tracks proposal status at generation time (regeneration reflects new status)', async () => {
    const base = proposal({ id: 'p-track', status: 'ready_for_review', payload: { _meta: { overallConfidence: 'low' } } });
    const pendingRun = await computeDigestPayload(TENANT, DATE, makeDeps({ confidenceMarked: [base] }));
    expect(pendingRun.unsureAbout?.[0].outcome).toBe('pending');
    const approved = { ...base, status: 'approved' as const };
    const approvedRun = await computeDigestPayload(TENANT, DATE, makeDeps({ confidenceMarked: [approved] }));
    expect(approvedRun.unsureAbout?.[0].outcome).toBe('approved');
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

  it('preserves overallConfidence from _meta and marks reviewInApp for low/very_low', () => {
    // high confidence → no reviewInApp, overallConfidence preserved
    const high = summarizeProposalForDigest(proposal({ payload: { _meta: { overallConfidence: 'high' } } }));
    expect(high.overallConfidence).toBe('high');
    expect(high.reviewInApp).toBeUndefined();

    // medium confidence → no reviewInApp
    const medium = summarizeProposalForDigest(proposal({ payload: { _meta: { overallConfidence: 'medium' } } }));
    expect(medium.overallConfidence).toBe('medium');
    expect(medium.reviewInApp).toBeUndefined();

    // low confidence → reviewInApp: true
    const low = summarizeProposalForDigest(proposal({ payload: { _meta: { overallConfidence: 'low' } } }));
    expect(low.overallConfidence).toBe('low');
    expect(low.reviewInApp).toBe(true);

    // very_low confidence → reviewInApp: true
    const veryLow = summarizeProposalForDigest(proposal({ payload: { _meta: { overallConfidence: 'very_low' } } }));
    expect(veryLow.overallConfidence).toBe('very_low');
    expect(veryLow.reviewInApp).toBe(true);

    // absent _meta → no overallConfidence, no reviewInApp (unchanged behavior)
    const absent = summarizeProposalForDigest(proposal({ payload: {} }));
    expect(absent.overallConfidence).toBeUndefined();
    expect(absent.reviewInApp).toBeUndefined();
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

describe('renderDigestSmsSegments', () => {
  const DEEP = 'https://app.example.com/digest/2026-06-10';
  const longUrl = (i: number) =>
    `https://api.example.com/public/proposals/one-tap-approve?token=${'x'.repeat(160)}${i}`;
  const combine = (segs: string[]) => segs.join('\n');

  it('renders counts, top approvals with one-tap links, flags, expiry note, and the deep link', () => {
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
    const segments = renderDigestSmsSegments({
      payload,
      deepLinkUrl: DEEP,
      approvalLinks: payload.pendingApprovals.top.map((approval, i) => ({ approval, url: `https://x.co/t${i}` })),
    });
    const body = combine(segments);
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(DIGEST_SMS_MAX_CHARS);
    expect(body).toContain('$450 in');
    expect(body).toContain('3 jobs done');
    expect(body).toContain('Tomorrow: 4 visits');
    expect(body).toContain('Approvals: 3 waiting');
    expect(body).toContain('[1] draft estimate $450 Lopez https://x.co/t0');
    expect(body).toContain('https://x.co/t1');
    expect(body).toContain('https://x.co/t2');
    expect(body).toContain('(links expire in 30 min)');
    expect(body).toContain('Flags: 2 overdue, 1 unbilled.');
    expect(body).toContain(DEEP);
  });

  it('emits a single un-prefixed segment when the whole digest fits under the soft limit', () => {
    const segments = renderDigestSmsSegments({
      payload: basePayload(),
      deepLinkUrl: DEEP,
      approvalLinks: [],
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]).not.toMatch(/^\(\d+\/\d+\)/);
    expect(segments[0].length).toBeLessThanOrEqual(DIGEST_SMS_SOFT_LIMIT);
  });

  it('splits into >=2 (k/n)-prefixed segments when content exceeds 320; links survive, deep link only in the final segment', () => {
    const payload = basePayload({
      pendingApprovals: {
        totalCount: 3,
        top: [
          { proposalId: 'p1', proposalType: 'draft_estimate', summary: 's', amountCents: 45000 },
          { proposalId: 'p2', proposalType: 'send_invoice', summary: 's' },
          { proposalId: 'p3', proposalType: 'add_note', summary: 's' },
        ],
      },
    });
    const segments = renderDigestSmsSegments({
      payload,
      deepLinkUrl: DEEP,
      approvalLinks: payload.pendingApprovals.top.map((approval, i) => ({ approval, url: longUrl(i) })),
    });
    expect(segments.length).toBeGreaterThanOrEqual(2);
    // Each segment ≤ the hard ceiling; the (k/n) prefix is present when split.
    segments.forEach((s, i) => {
      expect(s.length).toBeLessThanOrEqual(DIGEST_SMS_MAX_CHARS);
      expect(s).toMatch(new RegExp(`^\\(${i + 1}/${segments.length}\\) `));
    });
    // All three one-tap URLs survive (never collapsed to "+N more").
    const body = combine(segments);
    for (let i = 0; i < 3; i++) expect(body).toContain(longUrl(i));
    expect(body).not.toMatch(/\+\d more/);
    // Deep link appears ONLY in the final segment.
    const deepCount = segments.filter((s) => s.includes(DEEP)).length;
    expect(deepCount).toBe(1);
    expect(segments[segments.length - 1]).toContain(DEEP);
  });

  it('regenerates byte-identical segments given identical inputs (deterministic)', () => {
    const payload = basePayload({
      quotesSent: { count: 2, pipelineValueCents: 50000 },
      learnedToday: [{ lessonId: 'l1', lessonType: 'labor_rate_changed', summary: 'labor rate now $145' }],
    });
    const input = { payload, deepLinkUrl: DEEP, approvalLinks: [] };
    expect(renderDigestSmsSegments(input)).toEqual(renderDigestSmsSegments(input));
  });

  it('never slices through a one-tap URL when a single chunk exceeds the hard cap (money/link integrity)', () => {
    // A long customer name + a long signed one-tap URL pushes a single approval
    // chunk past the 480-char hard ceiling. The URL sits at the END of the
    // chunk, so a blind tail slice would corrupt the signed token → an unusable
    // approval link. Assert the FULL URL survives intact and the token is never
    // cut, while a normal-length approval in the same digest still renders fully.
    const hugeToken = 'y'.repeat(240);
    const bigUrl = `https://api.example.com/public/proposals/one-tap-approve?token=${hugeToken}`;
    const normalUrl = 'https://x.co/normal';
    const longName = 'A'.repeat(260); // long label pushes the chunk over the cap

    const payload = basePayload({
      pendingApprovals: {
        totalCount: 2,
        top: [
          { proposalId: 'p-big', proposalType: 'draft_estimate', summary: 's', customerName: longName, amountCents: 45000 },
          { proposalId: 'p-norm', proposalType: 'send_invoice', summary: 's', customerName: 'Lopez', amountCents: 12000 },
        ],
      },
    });
    const segments = renderDigestSmsSegments({
      payload,
      deepLinkUrl: DEEP,
      approvalLinks: [
        { approval: payload.pendingApprovals.top[0], url: bigUrl },
        { approval: payload.pendingApprovals.top[1], url: normalUrl },
      ],
    });
    const body = combine(segments);

    // Hard ceiling still honored on every segment.
    for (const s of segments) expect(s.length).toBeLessThanOrEqual(DIGEST_SMS_MAX_CHARS);
    // The full signed one-tap URL survives verbatim — the token is never sliced.
    expect(body).toContain(bigUrl);
    expect(body).toContain(hugeToken);
    // The normal-length approval still renders its full URL.
    expect(body).toContain(normalUrl);
    // A truncated variant of the signed URL (token cut short) must never appear
    // as the tail of a segment.
    for (const s of segments) {
      if (s.includes('one-tap-approve') && !s.includes(bigUrl)) {
        throw new Error(`segment carries a truncated one-tap URL: ${s.slice(-60)}`);
      }
    }
  });

  it('omits the approvals section and reflection lines entirely when absent', () => {
    const body = combine(
      renderDigestSmsSegments({ payload: basePayload(), deepLinkUrl: DEEP, approvalLinks: [] }),
    );
    expect(body).not.toContain('Approvals');
    expect(body).not.toContain('links expire');
    expect(body).not.toContain('Unsure:');
    expect(body).not.toContain('Learned:');
    expect(body).not.toContain('Quotes:');
  });

  it('renders the quotes-sent, unsure, and learned compact lines when present', () => {
    const payload = basePayload({
      quotesSent: { count: 2, pipelineValueCents: 123400 },
      unsureAbout: [
        { proposalId: 'u1', proposalType: 'draft_estimate', summary: 's', confidence: 'very_low', outcome: 'approved' },
        { proposalId: 'u2', proposalType: 'draft_estimate', summary: 's', confidence: 'low', outcome: 'approved' },
        { proposalId: 'u3', proposalType: 'draft_estimate', summary: 's', confidence: 'low', outcome: 'rejected' },
      ],
      learnedToday: [
        { lessonId: 'l1', lessonType: 'labor_rate_changed', summary: 'labor rate now $145' },
        { lessonId: 'l2', lessonType: 'part_price_changed', summary: 'filter is $30' },
      ],
    });
    const body = combine(renderDigestSmsSegments({ payload, deepLinkUrl: DEEP, approvalLinks: [] }));
    expect(body).toContain('Quotes: 2 sent, $1234 pipeline.');
    expect(body).toContain('Unsure: 3 flagged (2 approved, 1 rejected).');
    expect(body).toContain('Learned: labor rate now $145; 1 more.');
  });

  it('renders the feedback line with average and low-rating flag; omits it when empty', () => {
    const withFb = combine(
      renderDigestSmsSegments({
        payload: basePayload({ feedback: { responses: 4, averageRating: 4.3, lowRatingCount: 1 } }),
        deepLinkUrl: DEEP,
        approvalLinks: [],
      }),
    );
    expect(withFb).toContain('Feedback: 4 today, avg 4.3/5, 1 low (<=3).');

    const noFb = combine(
      renderDigestSmsSegments({
        payload: basePayload({ feedback: { responses: 0, averageRating: null, lowRatingCount: 0 } }),
        deepLinkUrl: DEEP,
        approvalLinks: [],
      }),
    );
    expect(noFb).not.toContain('Feedback:');
  });
});

describe('proposalOutcome', () => {
  it('maps every proposal status to the digest outcome', () => {
    expect(proposalOutcome('draft')).toBe('pending');
    expect(proposalOutcome('ready_for_review')).toBe('pending');
    expect(proposalOutcome('approved')).toBe('approved');
    expect(proposalOutcome('executing')).toBe('approved');
    expect(proposalOutcome('executed')).toBe('executed');
    expect(proposalOutcome('rejected')).toBe('rejected');
    expect(proposalOutcome('expired')).toBe('expired');
    expect(proposalOutcome('undone')).toBe('undone');
    expect(proposalOutcome('execution_failed')).toBe('failed');
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
