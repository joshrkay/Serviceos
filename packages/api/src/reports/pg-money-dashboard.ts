import { InvoiceRepository } from '../invoices/invoice';
import { PaymentRepository } from '../invoices/payment';
import { ExpenseRepository } from '../expenses/expense';
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
 * The fetches are deliberately narrow: payments are pulled for the
 * two-month [priorStart, end) span; invoices are pulled unfiltered (the
 * dashboard's outstanding/overdue are a current snapshot, and a solo
 * operator's open-invoice set is small); expenses are pulled for the
 * one-month window.
 */
export class PgMoneyDashboardRepository implements MoneyDashboardRepository {
  constructor(
    private readonly invoiceRepo: InvoiceRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly expenseRepo: ExpenseRepository,
  ) {}

  async query(tenantId: string, month: string, now: Date): Promise<MoneyDashboardSummary> {
    const { start, end, priorStart } = resolveMonthWindow(month);
    const [invoices, payments, expenses] = await Promise.all([
      this.invoiceRepo.findByTenant(tenantId),
      this.paymentRepo.findByTenant(tenantId, {
        status: 'completed',
        from: priorStart,
        to: end,
      }),
      this.expenseRepo.findByTenant(tenantId, { from: start, to: end }),
    ]);
    return computeMoneyDashboardSummary({ month, now, invoices, payments, expenses });
  }
}
