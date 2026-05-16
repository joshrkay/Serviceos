import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { RevenueBySourceRepository } from '../reports/revenue-by-source';
import { MoneyDashboardRepository } from '../reports/money-dashboard';
import { ExpenseRepository } from '../expenses/expense';
import { InvoiceRepository, Invoice } from '../invoices/invoice';
import { PaymentRepository } from '../invoices/payment';
import { buildTaxExportCsv, TaxExportRow } from '../reports/tax-export';
import { TimeGivenBackReporter } from '../reports/time-given-back';

/**
 * Tenant-scoped reporting endpoints. Add new reports here rather than
 * spinning up a separate router per metric.
 *
 * The signature is an options object so multiple launch plans can each
 * add a report without colliding on positional params (see §8 / §9
 * plans). All deps are optional; a route 503s if its dep is absent.
 */
export interface ReportsRouterDeps {
  revenueBySourceRepo: RevenueBySourceRepository;
  moneyDashboardRepo?: MoneyDashboardRepository;
  expenseRepo?: ExpenseRepository;
  invoiceRepo?: InvoiceRepository;
  paymentRepo?: PaymentRepository;
  /** §9 — backs GET /time-given-back. 503 when absent. */
  timeGivenBackReporter?: TimeGivenBackReporter;
}

/** 'YYYY-MM' for the current UTC month. */
function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function createReportsRouter(deps: ReportsRouterDeps): Router {
  const router = Router();

  router.get(
    '/revenue-by-source',
    requireAuth,
    requireTenant,
    // Reuses the invoices:view permission — anyone who can see invoices
    // can see how they were attributed.
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const fromRaw = req.query.from as string | undefined;
        const toRaw = req.query.to as string | undefined;
        const from = fromRaw ? new Date(fromRaw) : undefined;
        const to = toRaw ? new Date(toRaw) : undefined;
        if (fromRaw && Number.isNaN(from!.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `from` date' });
          return;
        }
        if (toRaw && Number.isNaN(to!.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `to` date' });
          return;
        }
        const rows = await deps.revenueBySourceRepo.query(req.auth!.tenantId, { from, to });
        res.json({ data: rows });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/money-dashboard',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.moneyDashboardRepo) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Money dashboard unavailable' });
          return;
        }
        const month = (req.query.month as string | undefined) || currentMonth();
        if (!/^\d{4}-\d{2}$/.test(month)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: "`month` must be 'YYYY-MM'" });
          return;
        }
        const summary = await deps.moneyDashboardRepo.query(req.auth!.tenantId, month, new Date());
        res.json({ data: summary });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/tax-export',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.expenseRepo || !deps.invoiceRepo || !deps.paymentRepo) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Tax export unavailable' });
          return;
        }
        const fromRaw = req.query.from as string | undefined;
        const toRaw = req.query.to as string | undefined;
        if (!fromRaw || !toRaw) {
          res
            .status(400)
            .json({ error: 'VALIDATION_ERROR', message: 'Both `from` and `to` are required' });
          return;
        }
        const from = new Date(fromRaw);
        const to = new Date(toRaw);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid `from`/`to` date' });
          return;
        }
        if (from.getTime() >= to.getTime()) {
          res
            .status(400)
            .json({ error: 'VALIDATION_ERROR', message: '`from` must be before `to`' });
          return;
        }

        // Cash-basis tax export: income is bucketed by when the cash arrived
        // (payment.receivedAt), not when the invoice was issued. Drives the
        // export off completed AND refunded payments in the window — a
        // refunded payment still represents cash that arrived in this
        // period for tax purposes (the refund itself happens later, and
        // ideally would be a negative line in its own period, but the
        // schema doesn't yet carry a `refundedAt` date — so we flag the
        // row with `[REFUNDED]` in the description and let the accountant
        // adjust manually). Invoice rows are looked up by ID and cached so
        // a tenant with many historic paid invoices doesn't blow up the
        // response.
        const tenantId = req.auth!.tenantId;
        const [completed, refunded, expenses] = await Promise.all([
          deps.paymentRepo.findByTenant(tenantId, {
            status: 'completed',
            from,
            to,
          }),
          deps.paymentRepo.findByTenant(tenantId, {
            status: 'refunded',
            from,
            to,
          }),
          deps.expenseRepo.findByTenant(tenantId, { from, to }),
        ]);
        const refundedIds = new Set(refunded.map((p) => p.id));
        const payments = [...completed, ...refunded];

        // Batch invoice lookup: dedupe by id and fetch in parallel so a
        // window with N distinct invoices is one round-trip, not N
        // sequential awaits.
        const uniqueInvoiceIds = [...new Set(payments.map((p) => p.invoiceId))];
        const fetchedInvoices = await Promise.all(
          uniqueInvoiceIds.map((id) => deps.invoiceRepo!.findById(tenantId, id)),
        );
        const invoiceCache = new Map<string, Invoice>();
        for (let i = 0; i < uniqueInvoiceIds.length; i++) {
          const inv = fetchedInvoices[i];
          if (inv) invoiceCache.set(uniqueInvoiceIds[i], inv);
        }

        const rows: TaxExportRow[] = [];
        for (const payment of payments) {
          const inv = invoiceCache.get(payment.invoiceId);
          if (!inv) continue; // orphan payment; FK should prevent
          const isRefunded = refundedIds.has(payment.id);
          rows.push({
            date: payment.receivedAt.toISOString().slice(0, 10),
            type: 'income',
            category: 'invoice',
            description: isRefunded ? `[REFUNDED] ${inv.invoiceNumber}` : inv.invoiceNumber,
            jobId: inv.jobId,
            amountCents: payment.amountCents,
          });
        }
        for (const exp of expenses) {
          rows.push({
            date: exp.spentAt.toISOString().slice(0, 10),
            type: 'expense',
            category: exp.category,
            description: exp.description,
            ...(exp.jobId ? { jobId: exp.jobId } : {}),
            amountCents: exp.amountCents,
          });
        }
        rows.sort((a, b) => a.date.localeCompare(b.date));

        const csv = buildTaxExportCsv(rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="tax-export-${fromRaw}-to-${toRaw}.csv"`,
        );
        res.send(csv);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/time-given-back',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.timeGivenBackReporter) {
          res
            .status(503)
            .json({ error: 'NOT_CONFIGURED', message: 'Time-given-back report unavailable' });
          return;
        }
        const summary = await deps.timeGivenBackReporter.query(req.auth!.tenantId, new Date());
        res.json({ data: summary });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
