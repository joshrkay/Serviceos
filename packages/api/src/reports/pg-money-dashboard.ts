import { InvoiceRepository } from '../invoices/invoice';
import { PaymentRepository } from '../invoices/payment';
import { ExpenseRepository } from '../expenses/expense';
import { SettingsRepository } from '../settings/settings';
import {
  MoneyDashboardRepository,
  MoneyDashboardSummary,
  computeMoneyDashboardSummary,
  resolveMonthWindow,
} from './money-dashboard';

/**
 * Production money-dashboard repository. Rather than hand-roll a
 * separate SQL aggregation (which would be a second, untested
 * implementation of the money math), it pulls the relevant row-sets
 * through the existing tenant-scoped repositories — each already
 * RLS-scoped — and runs the single tested `computeMoneyDashboardSummary`.
 *
 * The fetches are deliberately narrow:
 * - Payments: only completed, two-month [priorStart, end) span.
 * - Invoices: only status='open' + 'partially_paid' (the only statuses
 *   that contribute to outstanding/overdue). Two parallel queries
 *   because InvoiceListOptions.status is a single status, not an array.
 *   Filtering at the repo cap means closed/paid invoices never leave
 *   the database — a long-lived tenant's history doesn't bloat the
 *   rollup.
 * - Expenses: one-month window.
 */
export class PgMoneyDashboardRepository implements MoneyDashboardRepository {
  constructor(
    private readonly invoiceRepo: InvoiceRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly expenseRepo: ExpenseRepository,
    // Resolves the tenant's IANA timezone so the month window buckets at
    // tenant-local midnight (CLAUDE.md: times rendered in tenant tz).
    // Optional so legacy harnesses without settings wired fall back to UTC.
    private readonly settingsRepo?: SettingsRepository,
  ) {}

  async query(tenantId: string, month: string, now: Date): Promise<MoneyDashboardSummary> {
    const timezone =
      (this.settingsRepo
        ? (await this.settingsRepo.findByTenant(tenantId))?.timezone
        : undefined) ?? 'UTC';
    const { start, end, priorStart } = resolveMonthWindow(month, timezone);
    const [openInvoices, partiallyPaidInvoices, payments, expenses] = await Promise.all([
      this.invoiceRepo.findByTenant(tenantId, { status: 'open' }),
      this.invoiceRepo.findByTenant(tenantId, { status: 'partially_paid' }),
      this.paymentRepo.findByTenant(tenantId, {
        status: 'completed',
        from: priorStart,
        to: end,
      }),
      this.expenseRepo.findByTenant(tenantId, { from: start, to: end }),
    ]);
    const invoices = [...openInvoices, ...partiallyPaidInvoices];
    return computeMoneyDashboardSummary({ month, now, invoices, payments, expenses, timezone });
  }
}
