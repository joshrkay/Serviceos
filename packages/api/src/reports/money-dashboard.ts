import type { Invoice } from '../invoices/invoice';
import type { Payment } from '../invoices/payment';
import type { Expense } from '../expenses/expense';
import { tzMidnight } from '../shared/timezone';

/**
 * Money dashboard (§8) — a tenant-level rollup the owner sees at a
 * glance. Revenue, expenses, and the prior-month comparison are scoped
 * to the requested calendar month. Outstanding and overdue are *current
 * snapshots* (what is owed right now), independent of the month window
 * — that is how an owner reads them.
 *
 * `computeMoneyDashboardSummary` is pure: it takes already-fetched
 * arrays and `now`, and returns the summary. Repositories fetch the
 * arrays; this function owns the math.
 */
export interface MoneyDashboardSummary {
  month: string;
  /**
   * NET revenue inside the window: gross payments received minus refunds
   * dated by `refundedAt` inside the same window. This is the canonical
   * "money you actually kept this month" number an owner reads. Kept
   * named `revenueCents` for backward compatibility with existing
   * consumers — pre-D2-4 there were no refunds so net == gross.
   */
  revenueCents: number;
  /**
   * GROSS revenue inside the window: sum of completed payments received,
   * independent of refunds. Useful when distinguishing "what we charged"
   * from "what we kept". D2-4 added this field; before that, only the
   * net figure was reported.
   */
  grossRevenueCents: number;
  /**
   * Refunds whose `refundedAt` falls inside the window. Equals
   * `grossRevenueCents - revenueCents`. Exposed explicitly so the UI can
   * label the gap rather than make the owner derive it.
   */
  refundsCents: number;
  priorMonthRevenueCents: number;
  revenueTrendCents: number;
  expensesCents: number;
  outstandingCents: number;
  overdueCents: number;
}

export interface MoneyDashboardInput {
  month: string; // 'YYYY-MM'
  now: Date;
  invoices: Invoice[];
  payments: Payment[];
  expenses: Expense[];
  /**
   * IANA timezone the tenant operates in (e.g. 'America/Los_Angeles').
   * The month window is bucketed at tenant-local midnight so a payment
   * received 5pm PST on Jan 31 lands in January — not February, which is
   * where UTC bucketing would put it (UTC 01:00 Feb 1). Defaults to 'UTC'
   * to preserve the legacy behavior for callers that don't supply it.
   */
  timezone?: string;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

interface MonthWindow {
  start: Date;
  end: Date;
  priorStart: Date;
  priorEnd: Date;
}

export function resolveMonthWindow(month: string, timezone: string = 'UTC'): MonthWindow {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error("month must be a 'YYYY-MM' string");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error("month must be a 'YYYY-MM' string with month 01-12");
  }
  // Resolve each first-of-month to the UTC instant of tenant-local midnight.
  // Date.UTC normalizes the month index (12 → next Jan, -1 → prior Dec), and
  // toISOString yields the 'YYYY-MM-01' string tzMidnight expects.
  const firstOfMonth = (mIdx: number): Date => {
    const ymd = new Date(Date.UTC(year, mIdx, 1)).toISOString().slice(0, 10);
    return tzMidnight(ymd, timezone);
  };
  const start = firstOfMonth(monthIndex);
  const end = firstOfMonth(monthIndex + 1);
  const priorStart = firstOfMonth(monthIndex - 1);
  return { start, end, priorStart, priorEnd: start };
}

function inWindow(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}

export function computeMoneyDashboardSummary(input: MoneyDashboardInput): MoneyDashboardSummary {
  const { start, end, priorStart, priorEnd } = resolveMonthWindow(input.month, input.timezone);

  const completed = input.payments.filter((p) => p.status === 'completed');

  // D2-4 — refunds are NOT a status flip; they accumulate on the original
  // payment's `refundedAmountCents` and carry a `refundedAt` timestamp.
  // Bucket gross by `receivedAt` (when the cash arrived) and subtract
  // refunds bucketed by `refundedAt` (when the cash left). A refund
  // dated outside the window doesn't reduce THIS window's net even if
  // the original payment is inside it — that's the whole point of
  // tracking refunds as separate events.
  function refundsInWindow(windowStart: Date, windowEnd: Date): number {
    return completed
      .filter((p) => (p.refundedAmountCents ?? 0) > 0 && p.refundedAt)
      .filter((p) => inWindow(p.refundedAt!, windowStart, windowEnd))
      .reduce((sum, p) => sum + (p.refundedAmountCents ?? 0), 0);
  }

  const grossRevenueCents = completed
    .filter((p) => inWindow(p.receivedAt, start, end))
    .reduce((sum, p) => sum + p.amountCents, 0);
  const refundsCents = refundsInWindow(start, end);
  const revenueCents = grossRevenueCents - refundsCents;

  const priorGross = completed
    .filter((p) => inWindow(p.receivedAt, priorStart, priorEnd))
    .reduce((sum, p) => sum + p.amountCents, 0);
  const priorRefunds = refundsInWindow(priorStart, priorEnd);
  const priorMonthRevenueCents = priorGross - priorRefunds;

  const expensesCents = input.expenses
    .filter((e) => inWindow(e.spentAt, start, end))
    .reduce((sum, e) => sum + e.amountCents, 0);

  const owing = input.invoices.filter(
    (i) => i.status === 'open' || i.status === 'partially_paid',
  );
  const outstandingCents = owing.reduce((sum, i) => sum + i.amountDueCents, 0);
  const overdueCents = owing
    .filter((i) => i.dueDate !== undefined && i.dueDate.getTime() < input.now.getTime())
    .reduce((sum, i) => sum + i.amountDueCents, 0);

  return {
    month: input.month,
    revenueCents,
    grossRevenueCents,
    refundsCents,
    priorMonthRevenueCents,
    revenueTrendCents: revenueCents - priorMonthRevenueCents,
    expensesCents,
    outstandingCents,
    overdueCents,
  };
}

/**
 * Repository seam for the dashboard route. The in-memory variant is a
 * canned-summary stub for route-shape tests (mirrors
 * `InMemoryRevenueBySourceRepository`); the Pg variant (pg-money-dashboard.ts,
 * Task 7) does the real aggregation. The tested math lives in
 * `computeMoneyDashboardSummary` above.
 */
export interface MoneyDashboardRepository {
  query(tenantId: string, month: string, now: Date): Promise<MoneyDashboardSummary>;
}

export class InMemoryMoneyDashboardRepository implements MoneyDashboardRepository {
  private summary: MoneyDashboardSummary | null = null;

  /** Canned summary for route-shape tests. */
  setSummary(summary: MoneyDashboardSummary): void {
    this.summary = summary;
  }

  async query(_tenantId: string, month: string, _now: Date): Promise<MoneyDashboardSummary> {
    if (this.summary) return this.summary;
    return {
      month,
      revenueCents: 0,
      grossRevenueCents: 0,
      refundsCents: 0,
      priorMonthRevenueCents: 0,
      revenueTrendCents: 0,
      expensesCents: 0,
      outstandingCents: 0,
      overdueCents: 0,
    };
  }
}
