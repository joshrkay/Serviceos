import type { Invoice } from '../invoices/invoice';
import type { Payment } from '../invoices/payment';
import type { Expense } from '../expenses/expense';

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
  revenueCents: number;
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
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

interface MonthWindow {
  start: Date;
  end: Date;
  priorStart: Date;
  priorEnd: Date;
}

export function resolveMonthWindow(month: string): MonthWindow {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error("month must be a 'YYYY-MM' string");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error("month must be a 'YYYY-MM' string with month 01-12");
  }
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  const priorStart = new Date(Date.UTC(year, monthIndex - 1, 1));
  return { start, end, priorStart, priorEnd: start };
}

function inWindow(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}

export function computeMoneyDashboardSummary(input: MoneyDashboardInput): MoneyDashboardSummary {
  const { start, end, priorStart, priorEnd } = resolveMonthWindow(input.month);

  const completed = input.payments.filter((p) => p.status === 'completed');
  const revenueCents = completed
    .filter((p) => inWindow(p.receivedAt, start, end))
    .reduce((sum, p) => sum + p.amountCents, 0);
  const priorMonthRevenueCents = completed
    .filter((p) => inWindow(p.receivedAt, priorStart, priorEnd))
    .reduce((sum, p) => sum + p.amountCents, 0);

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
      priorMonthRevenueCents: 0,
      revenueTrendCents: 0,
      expensesCents: 0,
      outstandingCents: 0,
      overdueCents: 0,
    };
  }
}
