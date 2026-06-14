/**
 * P22-005 / U7 — Per-job profit (P&L) rollup.
 *
 * Answers "Did I make money on the <job>?" in INTEGER CENTS:
 *
 *   margin = revenue − labor − materials − expenses
 *
 *   revenue   = invoices linked to the job whose status counts as billed
 *               (open / partially_paid / paid — never draft/void/canceled),
 *               summed by their document total.
 *   labor     = time_entries with entry_type='job' on this job, total minutes
 *               × the tenant labor rate (laborRateCentsPerHour). When no rate
 *               is set the labor cost is left UNPRICED: marginCents is computed
 *               WITHOUT labor and `laborUnpriced` is true so the caller can add
 *               an honest spoken caveat.
 *   materials = job_parts cost when that table exists (P14). It does not yet,
 *               so materials are resolved through an injectable
 *               `materialsResolver` that defaults to 0 — the table-not-present
 *               case is the default, never a crash.
 *   expenses  = job-scoped `expenses` rows (expenses.job_id = job), summed by
 *               amount.
 *
 * This module owns the math and is pure aside from the repos it is handed; the
 * voice skill (ai/skills/lookup-job-profit.ts) and the
 * GET /api/reports/job-profit/:jobId route both call `getJobProfit`.
 *
 * Invariants: integer cents end-to-end (no floats); every read is
 * tenant-scoped (tenantId threads into every repo call).
 */
import type { InvoiceRepository, Invoice } from '../invoices/invoice';
import type { TimeEntryRepository } from '../time-tracking/time-entry';
import type { ExpenseRepository } from '../expenses/expense';

/**
 * Invoice statuses that count toward per-job revenue. A draft invoice is not
 * yet "brought in"; void/canceled invoices never were. open / partially_paid /
 * paid are the billed set — the same owing+settled span an owner means by
 * "what this job brought in".
 */
const REVENUE_INVOICE_STATUSES: ReadonlySet<Invoice['status']> = new Set([
  'open',
  'partially_paid',
  'paid',
]);

export interface JobProfit {
  /** Sum of billed invoice totals linked to the job (integer cents). */
  revenueCents: number;
  /**
   * Labor cost in integer cents (laborMinutes × rate ÷ 60, rounded to the
   * nearest cent). `null` when the tenant has no labor rate set — pair with
   * `laborUnpriced: true`.
   */
  laborCents: number | null;
  /** Total job-tagged minutes tracked against the job (entry_type='job'). */
  laborMinutes: number;
  /** Materials cost in integer cents (0 until job_parts / P14 lands). */
  materialsCents: number;
  /** Job-scoped expenses in integer cents. */
  expensesCents: number;
  /**
   * revenue − labor − materials − expenses. When labor is unpriced, labor is
   * treated as 0 in this figure (and `laborUnpriced` is true).
   */
  marginCents: number;
  /**
   * Margin as a percentage of revenue, rounded to one decimal place. `null`
   * when revenue is 0 (percentage is undefined — avoid divide-by-zero and a
   * misleading 0%/∞).
   */
  marginPct: number | null;
  /**
   * True when no labor rate was configured: laborCents is null and marginCents
   * excludes labor. The caller speaks a caveat ("not counting your labor
   * rate — set one in settings").
   */
  laborUnpriced: boolean;
}

/**
 * Resolves the materials cost (integer cents) for a job. Defaults to a zero
 * resolver: the P14 `job_parts` table does not exist yet, so the honest answer
 * is 0. When P14 lands, inject a resolver that sums job_parts cost — no change
 * to `getJobProfit` required. A resolver that throws (e.g. queries a missing
 * table) is treated as 0 so the rollup never crashes pre-P14.
 */
export type MaterialsResolver = (tenantId: string, jobId: string) => Promise<number>;

export const ZERO_MATERIALS_RESOLVER: MaterialsResolver = async () => 0;

export interface GetJobProfitInput {
  tenantId: string;
  jobId: string;
  /**
   * Tenant labor rate in integer cents per hour. Undefined/null ⇒ labor is
   * unpriced (minutes-only). Read from tenant settings by the caller so this
   * module stays free of a settings-repo dependency.
   */
  laborRateCentsPerHour?: number | null;
}

export interface GetJobProfitDeps {
  invoiceRepo: InvoiceRepository;
  timeEntryRepo: TimeEntryRepository;
  expenseRepo: ExpenseRepository;
  /** Defaults to {@link ZERO_MATERIALS_RESOLVER} when omitted. */
  materialsResolver?: MaterialsResolver;
}

/**
 * Convert tracked minutes to a labor cost in integer cents at a per-hour rate.
 * Rounds to the nearest cent (`Math.round`) so the result is always whole
 * cents — never a float that leaks downstream.
 */
export function computeLaborCents(minutes: number, rateCentsPerHour: number): number {
  return Math.round((minutes * rateCentsPerHour) / 60);
}

/**
 * Margin as a percentage of revenue, rounded to one decimal. Returns null when
 * revenue is 0 (percentage undefined). A negative margin yields a negative
 * percentage — the loss is reported honestly.
 */
export function computeMarginPct(marginCents: number, revenueCents: number): number | null {
  if (revenueCents === 0) return null;
  return Math.round((marginCents / revenueCents) * 1000) / 10;
}

export async function getJobProfit(
  input: GetJobProfitInput,
  deps: GetJobProfitDeps,
): Promise<JobProfit> {
  const { tenantId, jobId } = input;
  const materialsResolver = deps.materialsResolver ?? ZERO_MATERIALS_RESOLVER;

  const [invoices, timeEntries, expenses, materialsCents] = await Promise.all([
    deps.invoiceRepo.findByJob(tenantId, jobId),
    deps.timeEntryRepo.findByJob(tenantId, jobId),
    deps.expenseRepo.findByTenant(tenantId, { jobId }),
    materialsResolver(tenantId, jobId).catch(() => 0),
  ]);

  const revenueCents = invoices
    .filter((inv) => REVENUE_INVOICE_STATUSES.has(inv.status))
    .reduce((sum, inv) => sum + inv.totals.totalCents, 0);

  // Labor minutes: only entry_type='job' entries count toward a job's labor
  // cost — drive/break/admin time is not job labor. Closed entries carry a
  // durationMinutes; open entries (no clock-out yet) contribute 0.
  const laborMinutes = timeEntries
    .filter((e) => e.entryType === 'job')
    .reduce((sum, e) => sum + (e.durationMinutes ?? 0), 0);

  const expensesCents = expenses.reduce((sum, e) => sum + e.amountCents, 0);

  const rate = input.laborRateCentsPerHour;
  const hasRate = typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
  const laborUnpriced = !hasRate;
  const laborCents = hasRate ? computeLaborCents(laborMinutes, rate) : null;

  // Unpriced labor is excluded from the margin (treated as 0) so the figure is
  // honest about what it does NOT account for — the caller surfaces the caveat.
  const marginCents = revenueCents - (laborCents ?? 0) - materialsCents - expensesCents;
  const marginPct = computeMarginPct(marginCents, revenueCents);

  return {
    revenueCents,
    laborCents,
    laborMinutes,
    materialsCents,
    expensesCents,
    marginCents,
    marginPct,
    laborUnpriced,
  };
}
