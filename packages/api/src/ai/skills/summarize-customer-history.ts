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
 * succeeded and mark the affected field as `unavailable`. Never throw —
 * a partial summary still grounds the call better than no summary.
 *
 * Performance budget: a small constant number of DB reads — the job
 * list, one batched `findByJobs` for all invoices, and an agreement
 * read. Expected p95 < 300ms. Runs once per session at greeting →
 * identifying transition; cached on the session for the rest of the call.
 *
 * Note on customer-scoped invoice aggregation:
 *   `InvoiceRepository.findByTenant({ customerId })` accepts a
 *   `customerId` option type-wise, but neither the Pg nor InMemory
 *   implementation actually filters on it (verified against
 *   `pg-invoice.ts:buildListWhere` and `invoice.ts:findByTenant`). Using
 *   that path would aggregate the entire tenant's open balance into
 *   this customer's session context — a real correctness bug surfaced
 *   in PR #249 review. Invoices are customer-linked only via `job_id`
 *   (there is no `invoices.customer_id` column), so we aggregate with a
 *   single batched `findByJobs` over the customer's jobs.
 */

import type { JobRepository, JobStatus, Job } from '../../jobs/job';
import type { InvoiceRepository, InvoiceStatus, Invoice } from '../../invoices/invoice';
import type { AgreementRepository } from '../../agreements/agreement';

export interface CustomerHistorySummaryInput {
  tenantId: string;
  customerId: string;
  /**
   * Number of most-recent jobs to surface in `recentJobs`. Default 5 —
   * enough to detect a repeat issue ("third call about the same
   * furnace") without blowing the prompt token budget. Note: the FULL
   * job set (not just the recent slice) drives `hasOpenWorkOrders` and
   * the invoice fan-out, so an older still-active job is visible.
   */
  recentJobLimit?: number;
}

export interface CustomerHistorySummary {
  customerId: string;
  /** Most-recent jobs sorted newest-first, capped at `recentJobLimit`. May be empty for first-time callers. */
  recentJobs: Array<{
    id: string;
    summary: string;
    status: JobStatus;
    createdAt: Date;
    assignedTechnicianId?: string;
  }>;
  /** Aggregate open-balance state. `unavailable: true` when any per-job invoice fetch failed. */
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
   *
   * The `*Unavailable` family flags transient repo failures: when set,
   * the corresponding "happy" flag (e.g. `isFirstTimeCaller`) is
   * unreliable and consumers must NOT trust it as a positive signal.
   */
  flags: {
    hasOpenWorkOrders: boolean;
    isAgreementHolder: boolean;
    hasOverdueBalance: boolean;
    /**
     * `true` only when we successfully queried jobs AND found none.
     * `false` when jobs exist OR job fetch failed — never marks an
     * unknown caller "first-time" on a transient DB blip.
     */
    isFirstTimeCaller: boolean;
    /** Set when `findByCustomer` is missing or threw. Other job-derived flags are unreliable. */
    jobHistoryUnavailable: boolean;
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

const ACTIVE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'new',
  'scheduled',
  'in_progress',
]);

export async function summarizeCustomerHistory(
  input: CustomerHistorySummaryInput,
  deps: CustomerHistorySummaryDeps,
): Promise<CustomerHistorySummary> {
  const recentJobLimit = input.recentJobLimit ?? DEFAULT_RECENT_JOB_LIMIT;

  // ── Step 1: fetch FULL job set (no limit) so hasOpenWorkOrders covers
  // every customer job, not just the most-recent N. We slice for the
  // `recentJobs` field after.
  const { jobs: allJobs, available: jobHistoryAvailable } =
    await fetchAllCustomerJobs(deps.jobRepo, input.tenantId, input.customerId);

  const sortedJobs = allJobs
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const recentJobs = sortedJobs.slice(0, recentJobLimit).map((j) => ({
    id: j.id,
    summary: j.summary,
    status: j.status,
    createdAt: j.createdAt,
    assignedTechnicianId: j.assignedTechnicianId,
  }));

  const hasOpenWorkOrders = jobHistoryAvailable
    ? sortedJobs.some((j) => ACTIVE_JOB_STATUSES.has(j.status))
    : false;

  // ── Step 2: fan out invoices per-job + agreements in parallel.
  // Invoices via findByJob (which IS customer-scoped via job ownership)
  // because findByTenant({ customerId }) doesn't actually filter.
  const [openInvoices, activeAgreements] = await Promise.all([
    aggregateOpenInvoicesAcrossJobs(
      deps.invoiceRepo,
      input.tenantId,
      sortedJobs.map((j) => j.id),
      jobHistoryAvailable,
    ),
    fetchActiveAgreements(deps.agreementRepo, input.tenantId, input.customerId),
  ]);

  const lastTechnicianId = sortedJobs.find((j) => j.assignedTechnicianId)
    ?.assignedTechnicianId;

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
      // Only true when we successfully queried jobs AND found none.
      // Failure (or missing findByCustomer) means we don't know.
      isFirstTimeCaller: jobHistoryAvailable && sortedJobs.length === 0,
      jobHistoryUnavailable: !jobHistoryAvailable,
    },
    ...(lastTechnicianId ? { lastTechnicianId } : {}),
  };
}

async function fetchAllCustomerJobs(
  repo: JobRepository,
  tenantId: string,
  customerId: string,
): Promise<{ jobs: Job[]; available: boolean }> {
  if (!repo.findByCustomer) {
    // Repo doesn't expose customer-scoped lookups; we genuinely can't
    // know. Treat as unavailable so isFirstTimeCaller stays false.
    return { jobs: [], available: false };
  }
  try {
    const jobs = await repo.findByCustomer(tenantId, customerId, {
      includeArchived: true,
      // No limit — full set drives hasOpenWorkOrders + invoice fan-out.
    });
    return { jobs, available: true };
  } catch {
    return { jobs: [], available: false };
  }
}

async function fetchActiveAgreements(
  repo: AgreementRepository,
  tenantId: string,
  customerId: string,
): Promise<CustomerHistorySummary['activeAgreements']> {
  try {
    // Repo filters by status='active' AND customerId server-side
    // (verified against InMemoryAgreementRepository.findByTenant +
    // PgAgreementRepository.findByTenant). No client-side re-filter.
    const rows = await repo.findByTenant(tenantId, {
      customerId,
      status: 'active',
    });
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      nextRunAt: a.nextRunAt,
      priceCents: a.priceCents,
    }));
  } catch {
    return [];
  }
}

async function aggregateOpenInvoicesAcrossJobs(
  repo: InvoiceRepository,
  tenantId: string,
  jobIds: string[],
  jobHistoryAvailable: boolean,
): Promise<CustomerHistorySummary['openInvoices']> {
  // If we couldn't enumerate jobs, we can't enumerate invoices either —
  // mark unavailable so consumers don't treat 0 as "no balance."
  if (!jobHistoryAvailable) {
    return { count: 0, totalDueCents: 0, unavailable: true };
  }
  if (jobIds.length === 0) {
    // Genuine "no jobs, no invoices" — not a failure.
    return { count: 0, totalDueCents: 0 };
  }
  // Single batched read for all of the customer's jobs (was an O(jobs)
  // findByJob fan-out). A failure marks the aggregate unavailable —
  // partial/zero data would understate the customer's balance, so flag it
  // rather than mislead downstream skills.
  let allInvoices: Invoice[];
  try {
    allInvoices = await repo.findByJobs(tenantId, jobIds);
  } catch {
    return { count: 0, totalDueCents: 0, unavailable: true };
  }
  const open = allInvoices.filter((inv) => OPEN_INVOICE_STATUSES.has(inv.status));
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
