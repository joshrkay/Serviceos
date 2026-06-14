/**
 * Gather a tenant's day metrics for the digest (JTBD #7).
 *
 * Pulls each metric from its existing repo over a tenant-local day window
 * (computed by the caller from the tenant's IANA timezone). Every query
 * is best-effort: a single failing metric degrades to 0 rather than
 * failing the whole digest — a partial wrap-up still beats no wrap-up,
 * and the owner is never blocked by one flaky read.
 */
import { JobRepository } from '../../jobs/job';
import { PaymentRepository } from '../../invoices/payment';
import { InvoiceRepository } from '../../invoices/invoice';
import { ProposalRepository } from '../../proposals/proposal';
import { AppointmentRepository } from '../../appointments/appointment';
import { Logger } from '../../logging/logger';
import { DigestData } from './render';

/** Tenant-local day boundaries (UTC instants). */
export interface DigestWindow {
  /** Start of today, tenant-local. */
  todayStart: Date;
  /** End of today / start of tomorrow, tenant-local. */
  todayEnd: Date;
  /** End of tomorrow, tenant-local. */
  tomorrowEnd: Date;
}

export interface DigestGatherDeps {
  jobRepo: JobRepository;
  paymentRepo: PaymentRepository;
  invoiceRepo: InvoiceRepository;
  proposalRepo: ProposalRepository;
  appointmentRepo: AppointmentRepository;
  logger?: Logger;
}

const ACTIVE_APPOINTMENT = (status: string): boolean =>
  status !== 'canceled' && status !== 'no_show';

async function safe<T>(fn: () => Promise<T>, fallback: T, logger?: Logger, label?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger?.warn('digest: metric query failed, defaulting', {
      metric: label,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

export async function gatherDailyDigest(
  tenantId: string,
  window: DigestWindow,
  deps: DigestGatherDeps,
): Promise<DigestData> {
  const { todayStart, todayEnd, tomorrowEnd } = window;

  const jobsCompleted = safe(
    async () => {
      const jobs = await deps.jobRepo.findByTenant(tenantId, { status: 'completed' });
      return jobs.filter((j) => j.updatedAt >= todayStart && j.updatedAt < todayEnd).length;
    },
    0,
    deps.logger,
    'jobsCompleted',
  );

  const revenueCents = safe(
    async () => {
      const payments = await deps.paymentRepo.findByTenant(tenantId, {
        status: 'completed',
        from: todayStart,
        to: todayEnd,
      });
      // Net of refunds; never negative.
      return payments.reduce(
        (sum, p) => sum + Math.max(0, p.amountCents - p.refundedAmountCents),
        0,
      );
    },
    0,
    deps.logger,
    'revenueCents',
  );

  const pendingApprovals = safe(
    async () => {
      const [review, draft] = await Promise.all([
        deps.proposalRepo.findByStatus(tenantId, 'ready_for_review'),
        deps.proposalRepo.findByStatus(tenantId, 'draft'),
      ]);
      return review.length + draft.length;
    },
    0,
    deps.logger,
    'pendingApprovals',
  );

  const overdueInvoices = safe(
    async () => {
      const [open, partial] = await Promise.all([
        deps.invoiceRepo.findByTenant(tenantId, { status: 'open' }),
        deps.invoiceRepo.findByTenant(tenantId, { status: 'partially_paid' }),
      ]);
      return [...open, ...partial].filter(
        (inv) => inv.amountDueCents > 0 && inv.dueDate !== undefined && inv.dueDate < todayStart,
      ).length;
    },
    0,
    deps.logger,
    'overdueInvoices',
  );

  const todayAppointments = safe(
    async () => {
      const appts = await deps.appointmentRepo.findByDateRange(tenantId, todayStart, todayEnd);
      return appts.filter((a) => ACTIVE_APPOINTMENT(a.status)).length;
    },
    0,
    deps.logger,
    'todayAppointments',
  );

  const tomorrowAppointments = safe(
    async () => {
      const appts = await deps.appointmentRepo.findByDateRange(tenantId, todayEnd, tomorrowEnd);
      return appts.filter((a) => ACTIVE_APPOINTMENT(a.status)).length;
    },
    0,
    deps.logger,
    'tomorrowAppointments',
  );

  const [
    jobsCompletedN,
    revenueCentsN,
    pendingApprovalsN,
    overdueInvoicesN,
    todayAppointmentsN,
    tomorrowAppointmentsN,
  ] = await Promise.all([
    jobsCompleted,
    revenueCents,
    pendingApprovals,
    overdueInvoices,
    todayAppointments,
    tomorrowAppointments,
  ]);

  return {
    jobsCompleted: jobsCompletedN,
    revenueCents: revenueCentsN,
    pendingApprovals: pendingApprovalsN,
    overdueInvoices: overdueInvoicesN,
    todayAppointments: todayAppointmentsN,
    tomorrowAppointments: tomorrowAppointmentsN,
  };
}

/**
 * Compute the tenant-local day window from an IANA timezone + "now".
 * Pure given `now`; uses Intl to derive the local calendar date, then the
 * shared tz helpers for DST-safe midnight boundaries.
 */
export function computeDigestWindow(
  timezone: string,
  now: Date,
  tzMidnight: (ymd: string, tz: string) => Date,
  addCalendarDays: (d: Date, days: number, tz: string) => Date,
): DigestWindow {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const todayStart = tzMidnight(ymd, timezone);
  const todayEnd = addCalendarDays(todayStart, 1, timezone);
  const tomorrowEnd = addCalendarDays(todayStart, 2, timezone);
  return { todayStart, todayEnd, tomorrowEnd };
}
