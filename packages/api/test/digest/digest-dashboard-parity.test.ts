/**
 * RV-060 acceptance: the digest's money numbers must EXACTLY equal the
 * money dashboard's for the same day. Both sides here are computed from
 * the SAME fixture rows — the digest through `computeDigestPayload`, the
 * dashboard through `computeMoneyDashboardSummary` — with every fixture
 * payment/refund dated on a single tenant-local day so the month rollup
 * and the day rollup describe the same window of activity.
 */
import { describe, it, expect } from 'vitest';
import { computeMoneyDashboardSummary, isInvoiceOverdue } from '../../src/reports/money-dashboard';
import { computeDigestPayload, type DigestComputeDeps } from '../../src/digest/digest-service';
import type { Payment, PaymentRepository } from '../../src/invoices/payment';
import type { Invoice, InvoiceRepository } from '../../src/invoices/invoice';
import type { EstimateRepository } from '../../src/estimates/estimate';
import type { JobRepository } from '../../src/jobs/job';
import type { AppointmentRepository } from '../../src/appointments/appointment';
import type { ProposalRepository } from '../../src/proposals/proposal';
import type { CustomerRepository } from '../../src/customers/customer';
import type { SettingsRepository, TenantSettings } from '../../src/settings/settings';
import type { FeedbackResponseRepository } from '../../src/feedback/feedback-response';

const TENANT = 'tenant-parity';
const TZ = 'America/Los_Angeles';
const DATE = '2026-06-10';
const MONTH = '2026-06';
const NOW = new Date('2026-06-11T02:00:00Z'); // 2026-06-10 19:00 in LA

// Every payment/refund in the fixture happens on 2026-06-10 LA time, so the
// June dashboard window and the 06-10 digest window cover identical events.
const payments: Payment[] = [
  {
    id: 'p1',
    tenantId: TENANT,
    invoiceId: 'inv-1',
    amountCents: 123_45,
    method: 'credit_card',
    status: 'completed',
    receivedAt: new Date('2026-06-10T15:00:00Z'),
    processedBy: 'u1',
    createdAt: NOW,
    updatedAt: NOW,
    refundedAmountCents: 0,
  } as Payment,
  {
    id: 'p2',
    tenantId: TENANT,
    invoiceId: 'inv-2',
    amountCents: 500_00,
    method: 'cash',
    status: 'completed',
    receivedAt: new Date('2026-06-11T05:30:00Z'), // 22:30 LA — still 06-10
    processedBy: 'u1',
    createdAt: NOW,
    updatedAt: NOW,
    refundedAmountCents: 75_00,
    refundedAt: new Date('2026-06-11T06:00:00Z'), // 23:00 LA — still 06-10
  } as Payment,
  {
    id: 'p3-pending-ignored',
    tenantId: TENANT,
    invoiceId: 'inv-3',
    amountCents: 999_99,
    method: 'credit_card',
    status: 'pending',
    receivedAt: new Date('2026-06-10T16:00:00Z'),
    processedBy: 'u1',
    createdAt: NOW,
    updatedAt: NOW,
    refundedAmountCents: 0,
  } as Payment,
];

const invoices: Invoice[] = [
  {
    id: 'inv-overdue',
    status: 'open',
    amountDueCents: 40_00,
    dueDate: new Date('2026-06-01T00:00:00Z'),
    jobId: 'j1',
  } as unknown as Invoice,
  {
    id: 'inv-overdue-partial',
    status: 'partially_paid',
    amountDueCents: 25_00,
    dueDate: new Date('2026-06-05T00:00:00Z'),
    jobId: 'j2',
  } as unknown as Invoice,
  {
    id: 'inv-current',
    status: 'open',
    amountDueCents: 99_00,
    dueDate: new Date('2026-07-09T00:00:00Z'),
    jobId: 'j3',
  } as unknown as Invoice,
];

function deps(): DigestComputeDeps {
  return {
    paymentRepo: { findByTenant: async () => payments } as unknown as PaymentRepository,
    jobRepo: { findByTenant: async () => [] } as unknown as JobRepository,
    appointmentRepo: { findByDateRange: async () => [] } as unknown as AppointmentRepository,
    invoiceRepo: {
      findByTenant: async (_t: string, opts?: { status?: string }) =>
        invoices.filter((i) => i.status === opts?.status),
      findByJobs: async () => [],
    } as unknown as InvoiceRepository,
    estimateRepo: { findByJobs: async () => [] } as unknown as EstimateRepository,
    proposalRepo: { findByStatus: async () => [] } as unknown as ProposalRepository,
    customerRepo: { findById: async () => null } as unknown as CustomerRepository,
    settingsRepo: {
      findByTenant: async () => ({ timezone: TZ } as TenantSettings),
    } as unknown as SettingsRepository,
    feedbackResponseRepo: {
      countByRatingInRange: async () => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }),
    } as unknown as FeedbackResponseRepository,
    now: () => NOW,
  };
}

describe('digest ↔ money-dashboard parity (same fixture data)', () => {
  it('revenue (net/gross/refunds) and overdue agree exactly with the dashboard for the same day', async () => {
    const dashboard = computeMoneyDashboardSummary({
      month: MONTH,
      now: NOW,
      invoices,
      payments,
      expenses: [],
      timezone: TZ,
    });
    const digest = await computeDigestPayload(TENANT, DATE, deps());

    // All fixture money events fall on the single day — the month rollup
    // and the day digest MUST be byte-identical on every shared number.
    expect(digest.revenueCents).toBe(dashboard.revenueCents);
    expect(digest.grossRevenueCents).toBe(dashboard.grossRevenueCents);
    expect(digest.refundsCents).toBe(dashboard.refundsCents);

    // Sanity-pin the actual values so a symmetric bug in the shared
    // function can't fake parity.
    expect(digest.revenueCents).toBe(123_45 + 500_00 - 75_00);
    expect(digest.grossRevenueCents).toBe(123_45 + 500_00);
    expect(digest.refundsCents).toBe(75_00);

    // Overdue: the digest count is exactly the set the dashboard sums.
    const dashboardOverdue = invoices.filter((i) => isInvoiceOverdue(i, NOW));
    expect(digest.overdueInvoicesCount).toBe(dashboardOverdue.length);
    expect(dashboard.overdueCents).toBe(
      dashboardOverdue.reduce((s, i) => s + i.amountDueCents, 0),
    );
    expect(digest.overdueInvoicesCount).toBe(2);
  });
});
