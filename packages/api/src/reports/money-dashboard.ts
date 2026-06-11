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
   * IANA timezone identifier for the tenant. Used to define what
   * "calendar month" means: the window covers midnight on the first
   * of the month *in the tenant's local time* through midnight on
   * the first of the next month. Defaults to `America/New_York` to
   * match `tenant_settings.timezone`'s default (migration 013) so
   * existing callers that don't pass a tz get the same legacy-ish
   * behavior for US/Eastern tenants.
   */
  timezone?: string;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/**
 * Compute the UTC instant that corresponds to midnight (00:00) on the
 * given calendar date in the given IANA timezone.
 *
 * The naive approach — `Date.UTC(year, month, day)` — is wrong for any
 * tenant outside UTC: a tenant in PST who looks at "May 2026 revenue"
 * expects to bucket payments by PST-local midnight boundaries, not UTC
 * midnight boundaries. Off-by-four-to-eight-hours at month edges is the
 * difference between a payment showing up in May vs June for that
 * tenant.
 *
 * Algorithm: build a UTC instant at the candidate midnight, format it
 * through `Intl.DateTimeFormat` in the target timezone to read back the
 * wall-clock components, then compute the offset between the two and
 * subtract it. One round-trip handles DST too since we're using the
 * formatter's awareness of the zone at that exact instant.
 */
export function localMidnightToUTC(year: number, monthIndex: number, day: number, timezone: string): Date {
  const utcMidnight = Date.UTC(year, monthIndex, day);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMidnight));
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  // The wall-clock midnight UTC reads as in the target zone.
  const wallClock = Date.UTC(
    Number(m.year),
    Number(m.month) - 1,
    Number(m.day),
    Number(m.hour) === 24 ? 0 : Number(m.hour), // some locales emit 24 for midnight
    Number(m.minute),
    Number(m.second),
  );
  const offsetMs = wallClock - utcMidnight;
  return new Date(utcMidnight - offsetMs);
}

interface MonthWindow {
  start: Date;
  end: Date;
  priorStart: Date;
  priorEnd: Date;
}

/**
 * Resolve the month-window UTC instants for `month` in the given
 * timezone. `start` is midnight on the 1st in the tenant tz; `end` is
 * midnight on the 1st of the following month; `priorStart` is midnight
 * on the 1st of the prior month. All three are UTC `Date` instances
 * suitable for the existing `inWindow` half-open comparison.
 *
 * When `timezone` is omitted, falls back to `America/New_York` so
 * older callers (and the in-memory test fixture) keep working without
 * an API change.
 */
export function resolveMonthWindow(month: string, timezone = 'America/New_York'): MonthWindow {
  const match = MONTH_RE.exec(month);
  if (!match) throw new Error("month must be a 'YYYY-MM' string");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error("month must be a 'YYYY-MM' string with month 01-12");
  }
  const start = localMidnightToUTC(year, monthIndex, 1, timezone);
  const end = localMidnightToUTC(year, monthIndex + 1, 1, timezone);
  const priorStart = localMidnightToUTC(year, monthIndex - 1, 1, timezone);
  return { start, end, priorStart, priorEnd: start };
}

export function inWindow(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  return t >= start.getTime() && t < end.getTime();
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DayWindow {
  start: Date;
  end: Date;
}

/**
 * RV-060 — resolve the [start, end) UTC instants for one tenant-local
 * calendar day. Built on the SAME `localMidnightToUTC` the month window
 * uses, so the end-of-day digest buckets payments by exactly the same
 * tenant-tz midnight boundaries as the money dashboard (the digest's
 * numbers must never disagree with the dashboard's for the same day).
 */
export function resolveDayWindow(date: string, timezone = 'America/New_York'): DayWindow {
  const match = DATE_RE.exec(date);
  if (!match) throw new Error("date must be a 'YYYY-MM-DD' string");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (monthIndex < 0 || monthIndex > 11) {
    throw new Error("date must be a 'YYYY-MM-DD' string with month 01-12");
  }
  return {
    start: localMidnightToUTC(year, monthIndex, day, timezone),
    // Date.UTC handles day overflow (e.g. Jan 31 + 1 → Feb 1).
    end: localMidnightToUTC(year, monthIndex, day + 1, timezone),
  };
}

export interface WindowRevenue {
  grossRevenueCents: number;
  refundsCents: number;
  revenueCents: number;
}

/**
 * The single revenue computation both the month dashboard and the daily
 * digest (RV-060) run. D2-4 — refunds are NOT a status flip; they
 * accumulate on the original payment's `refundedAmountCents` and carry a
 * `refundedAt` timestamp. Bucket gross by `receivedAt` (when the cash
 * arrived) and subtract refunds bucketed by `refundedAt` (when the cash
 * left). A refund dated outside the window doesn't reduce THIS window's
 * net even if the original payment is inside it — that's the whole point
 * of tracking refunds as separate events.
 */
export function computeWindowRevenue(
  payments: Payment[],
  start: Date,
  end: Date,
): WindowRevenue {
  const completed = payments.filter((p) => p.status === 'completed');
  const grossRevenueCents = completed
    .filter((p) => inWindow(p.receivedAt, start, end))
    .reduce((sum, p) => sum + p.amountCents, 0);
  const refundsCents = completed
    .filter((p) => (p.refundedAmountCents ?? 0) > 0 && p.refundedAt)
    .filter((p) => inWindow(p.refundedAt!, start, end))
    .reduce((sum, p) => sum + (p.refundedAmountCents ?? 0), 0);
  return { grossRevenueCents, refundsCents, revenueCents: grossRevenueCents - refundsCents };
}

/** Invoice statuses that still owe money — the outstanding/overdue base set. */
export function isInvoiceOwing(invoice: Invoice): boolean {
  return invoice.status === 'open' || invoice.status === 'partially_paid';
}

/**
 * The single overdue predicate both the dashboard's `overdueCents` and the
 * digest's overdue-invoice count apply: still owing AND past its due date.
 */
export function isInvoiceOverdue(invoice: Invoice, now: Date): boolean {
  return (
    isInvoiceOwing(invoice) &&
    invoice.dueDate !== undefined &&
    invoice.dueDate.getTime() < now.getTime()
  );
}

export function computeMoneyDashboardSummary(input: MoneyDashboardInput): MoneyDashboardSummary {
  const { start, end, priorStart, priorEnd } = resolveMonthWindow(input.month, input.timezone);

  const { grossRevenueCents, refundsCents, revenueCents } = computeWindowRevenue(
    input.payments,
    start,
    end,
  );
  const priorMonthRevenueCents = computeWindowRevenue(
    input.payments,
    priorStart,
    priorEnd,
  ).revenueCents;

  const expensesCents = input.expenses
    .filter((e) => inWindow(e.spentAt, start, end))
    .reduce((sum, e) => sum + e.amountCents, 0);

  const owing = input.invoices.filter(isInvoiceOwing);
  const outstandingCents = owing.reduce((sum, i) => sum + i.amountDueCents, 0);
  const overdueCents = owing
    .filter((i) => isInvoiceOverdue(i, input.now))
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
  query(
    tenantId: string,
    month: string,
    now: Date,
    timezone?: string,
  ): Promise<MoneyDashboardSummary>;
}

export class InMemoryMoneyDashboardRepository implements MoneyDashboardRepository {
  private summary: MoneyDashboardSummary | null = null;

  /** Canned summary for route-shape tests. */
  setSummary(summary: MoneyDashboardSummary): void {
    this.summary = summary;
  }

  async query(
    _tenantId: string,
    month: string,
    _now: Date,
    _timezone?: string,
  ): Promise<MoneyDashboardSummary> {
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
