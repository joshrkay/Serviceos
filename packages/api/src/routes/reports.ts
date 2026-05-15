import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { RevenueBySourceRepository } from '../reports/revenue-by-source';
import { MoneyDashboardRepository } from '../reports/money-dashboard';
import { ExpenseRepository } from '../expenses/expense';
import { InvoiceRepository } from '../invoices/invoice';
import { buildTaxExportCsv, TaxExportRow } from '../reports/tax-export';

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
        if (!deps.expenseRepo || !deps.invoiceRepo) {
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

        const tenantId = req.auth!.tenantId;
        const [invoices, expenses] = await Promise.all([
          deps.invoiceRepo.findByTenant(tenantId, { status: 'paid' }),
          deps.expenseRepo.findByTenant(tenantId, { from, to }),
        ]);

        const rows: TaxExportRow[] = [];
        for (const inv of invoices) {
          const issued = inv.issuedAt ?? inv.createdAt;
          if (issued.getTime() < from.getTime() || issued.getTime() >= to.getTime()) continue;
          rows.push({
            date: issued.toISOString().slice(0, 10),
            type: 'income',
            category: 'invoice',
            description: inv.invoiceNumber,
            jobId: inv.jobId,
            amountCents: inv.totals.totalCents,
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

  return router;
}
