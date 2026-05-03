/**
 * Phase 4d-1 perception skill — `summarize-customer-history`.
 *
 * Loads structured customer context at session start (or on caller-ID
 * resolution within a session) so downstream skills — urgency classifier,
 * diagnostic state, next-best-action, intent classifier — can ground
 * their decisions in actual customer state instead of treating every
 * caller as a stranger.
 *
 * NOT a customer-facing lookup. The output is structured data, not
 * TTS-ready text. Consumers attach it to `session.context.customer` and
 * read fields directly. Customer-facing summaries (e.g. "you're a
 * Platinum member, your balance is $0") come from `lookup-*` skills,
 * which surface this same data via different presentation.
 *
 * Failure-soft contract: if any individual fan-out fails, return what
 * succeeded and mark the field as `unavailable`. Never throw — a
 * partial summary still grounds the call better than no summary at all.
 *
 * Performance budget: ~3 parallel DB reads, expected p95 < 200ms. Runs
 * once per session at greeting → identifying transition; cached on the
 * session for the rest of the call.
 */

import type { JobRepository, JobStatus } from '../../jobs/job';
import type { InvoiceRepository, InvoiceStatus } from '../../invoices/invoice';
import type { AgreementRepository } from '../../agreements/agreement';

export interface CustomerHistorySummaryInput {
  tenantId: string;
  customerId: string;
  /**
   * Number of most-recent jobs to surface. Default 5 — enough to detect
   * a repeat issue ("third call about the same furnace") without
   * blowing the prompt token budget.
   */
  recentJobLimit?: number;
}

export interface CustomerHistorySummary {
  customerId: string;
  /** Most-recent jobs sorted newest-first. May be empty for first-time callers. */
  recentJobs: Array<{
    id: string;
    summary: string;
    status: JobStatus;
    createdAt: Date;
    assignedTechnicianId?: string;
  }>;
  /** Aggregate open-balance state. `unavailable: true` when invoice fetch failed. */
  openInvoices: {
    count: number;
    totalDueCents: number;
    oldestDueDate?: Date;
    unavailable?: boolean;
  };
  /** Active service agreements (membership / maintenance plans). Empty for non-members. */
  activeAgreements: Array<{
    id: string;
    name: string;
    nextRunAt: Date;
    priceCents: number;
  }>;
  /**
   * Convenience flags downstream skills consume directly without
   * re-deriving from the arrays above.
   */
  flags: {
    hasOpenWorkOrders: boolean;
    isAgreementHolder: boolean;
    hasOverdueBalance: boolean;
    isFirstTimeCaller: boolean;
  };
  /** Most-recent technician who serviced this customer, if any. */
  lastTechnicianId?: string;
}

export interface CustomerHistorySummaryDeps {
  jobRepo: JobRepository;
  invoiceRepo: InvoiceRepository;
  agreementRepo: AgreementRepository;
}

const DEFAULT_RECENT_JOB_LIMIT = 5;

const OPEN_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  'open',
  'partially_paid',
]);

export async function summarizeCustomerHistory(
  input: CustomerHistorySummaryInput,
  deps: CustomerHistorySummaryDeps,
): Promise<CustomerHistorySummary> {
  const recentJobLimit = input.recentJobLimit ?? DEFAULT_RECENT_JOB_LIMIT;

  // Fan out — parallel reads. Each settled independently so a single
  // repo failure doesn't poison the whole summary.
  const [jobsResult, invoicesResult, agreementsResult] = await Promise.allSettled([
    deps.jobRepo.findByCustomer
      ? deps.jobRepo.findByCustomer(input.tenantId, input.customerId, {
          limit: recentJobLimit,
          includeArchived: true,
        })
      : Promise.resolve([]),
    deps.invoiceRepo.findByTenant(input.tenantId, {
      customerId: input.customerId,
    }),
    deps.agreementRepo.findByTenant(input.tenantId, {
      customerId: input.customerId,
      status: 'active',
    }),
  ]);

  const recentJobs =
    jobsResult.status === 'fulfilled'
      ? jobsResult.value
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, recentJobLimit)
          .map((j) => ({
            id: j.id,
            summary: j.summary,
            status: j.status,
            createdAt: j.createdAt,
            assignedTechnicianId: j.assignedTechnicianId,
          }))
      : [];

  const openInvoices = computeOpenInvoiceAggregate(invoicesResult);

  const activeAgreements =
    agreementsResult.status === 'fulfilled'
      ? agreementsResult.value
          .filter((a) => a.status === 'active')
          .map((a) => ({
            id: a.id,
            name: a.name,
            nextRunAt: a.nextRunAt,
            priceCents: a.priceCents,
          }))
      : [];

  const lastTechnicianId = recentJobs.find((j) => j.assignedTechnicianId)
    ?.assignedTechnicianId;

  const hasOpenWorkOrders = recentJobs.some(
    (j) => j.status === 'new' || j.status === 'scheduled' || j.status === 'in_progress',
  );

  const now = Date.now();
  const hasOverdueBalance =
    !openInvoices.unavailable &&
    openInvoices.oldestDueDate !== undefined &&
    openInvoices.oldestDueDate.getTime() < now;

  return {
    customerId: input.customerId,
    recentJobs,
    openInvoices,
    activeAgreements,
    flags: {
      hasOpenWorkOrders,
      isAgreementHolder: activeAgreements.length > 0,
      hasOverdueBalance,
      isFirstTimeCaller: recentJobs.length === 0,
    },
    ...(lastTechnicianId ? { lastTechnicianId } : {}),
  };
}

function computeOpenInvoiceAggregate(
  result: PromiseSettledResult<Awaited<ReturnType<InvoiceRepository['findByTenant']>>>,
): CustomerHistorySummary['openInvoices'] {
  if (result.status !== 'fulfilled') {
    return { count: 0, totalDueCents: 0, unavailable: true };
  }
  const open = result.value.filter((inv) =>
    OPEN_INVOICE_STATUSES.has(inv.status),
  );
  if (open.length === 0) {
    return { count: 0, totalDueCents: 0 };
  }
  const totalDueCents = open.reduce((sum, inv) => sum + inv.amountDueCents, 0);
  const dueDates = open
    .map((inv) => inv.dueDate)
    .filter((d): d is Date => d !== undefined);
  const oldestDueDate =
    dueDates.length > 0
      ? new Date(Math.min(...dueDates.map((d) => d.getTime())))
      : undefined;
  return {
    count: open.length,
    totalDueCents,
    ...(oldestDueDate ? { oldestDueDate } : {}),
  };
}
