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
import { ProposalRepository } from '../proposals/proposal';
import { AuditRepository } from '../audit/audit';
import { computeHfcrForTenant } from '../metrics/hfcr';
import { JobRepository } from '../jobs/job';
import { TimeEntryRepository } from '../time-tracking/time-entry';
import { SettingsRepository } from '../settings/settings';
import { getJobProfit, MaterialsResolver } from '../jobs/job-profit';
import { getCustomerProfit, type GetCustomerProfitDeps } from '../reports/customer-profit';
import { getTechnicianProfit } from '../reports/technician-profit';

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
  /** HFCR hero metric — backs GET /hfcr. All three required; 503 when any absent. */
  proposalRepo?: ProposalRepository;
  auditRepo?: AuditRepository;
  /**
   * P22-005 (U7) — backs GET /job-profit/:jobId. jobRepo + timeEntryRepo +
   * settingsRepo + invoiceRepo + expenseRepo are all required for the rollup;
   * the route 503s if any is absent. `materialsResolver` is optional (P14
   * job_parts is not built — materials default to 0 without it).
   */
  jobRepo?: JobRepository;
  timeEntryRepo?: TimeEntryRepository;
  settingsRepo?: SettingsRepository;
  materialsResolver?: MaterialsResolver;
  /**
   * Returns the tenant's IANA timezone string (e.g. `America/Los_Angeles`).
   * Used to bucket the money dashboard by tenant-local month boundaries —
   * without it, a payment received at 11 PM on the last day of the month
   * (UTC) ends up in the next month's bucket for any non-UTC tenant.
   * Optional; when absent the dashboard falls back to America/New_York
   * (matches `tenant_settings.timezone`'s default).
   */
  getTenantTimezone?: (tenantId: string) => Promise<string>;
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
        // Resolve the tenant tz so month boundaries align with the
        // operator's local calendar, not UTC. Falls back to undefined
        // (→ the repo's own default) on lookup error to keep the
        // dashboard responsive even if tenant_settings is unreachable.
        let timezone: string | undefined;
        if (deps.getTenantTimezone) {
          try {
            timezone = await deps.getTenantTimezone(req.auth!.tenantId);
          } catch {
            timezone = undefined;
          }
        }
        const summary = await deps.moneyDashboardRepo.query(
          req.auth!.tenantId,
          month,
          new Date(),
          timezone,
        );
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
    '/hfcr',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.paymentRepo || !deps.proposalRepo || !deps.auditRepo) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'HFCR unavailable' });
          return;
        }
        const month = (req.query.month as string | undefined) || currentMonth();
        if (!/^\d{4}-\d{2}$/.test(month)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: "`month` must be 'YYYY-MM'" });
          return;
        }
        const [year, mon] = month.split('-').map(Number);
        // UTC calendar-month window. A hero number tolerates UTC bucketing;
        // tenant-tz boundaries (as on /money-dashboard) are a later refinement.
        const period = {
          from: new Date(Date.UTC(year, mon - 1, 1)),
          to: new Date(Date.UTC(year, mon, 1)),
        };
        const result = await computeHfcrForTenant(req.auth!.tenantId, period, {
          paymentRepo: deps.paymentRepo,
          proposalRepo: deps.proposalRepo,
          auditRepo: deps.auditRepo,
        });
        res.json({ data: { month, ...result } });
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

  // P22-005 (U7) — per-job profit (P&L) for one job: revenue − labor −
  // materials − expenses, integer cents. Reuses invoices:view (anyone who can
  // see a job's invoices can see whether it made money). 404 when the job is
  // not in this tenant — tenant isolation is enforced both by RLS in the repos
  // and by the explicit findById tenant scope here.
  router.get(
    '/job-profit/:jobId',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (
          !deps.jobRepo ||
          !deps.invoiceRepo ||
          !deps.timeEntryRepo ||
          !deps.expenseRepo ||
          !deps.settingsRepo
        ) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Job profit unavailable' });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const jobId = req.params.jobId;

        const job = await deps.jobRepo.findById(tenantId, jobId);
        if (!job) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
          return;
        }

        const settings = await deps.settingsRepo.findByTenant(tenantId);
        const profit = await getJobProfit(
          {
            tenantId,
            jobId,
            laborRateCentsPerHour: settings?.laborRateCentsPerHour ?? null,
          },
          {
            invoiceRepo: deps.invoiceRepo,
            timeEntryRepo: deps.timeEntryRepo,
            expenseRepo: deps.expenseRepo,
            ...(deps.materialsResolver ? { materialsResolver: deps.materialsResolver } : {}),
          },
        );
        res.json({ data: profit });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  // Customer profitability — aggregates per-job profit across a customer's
  // jobs. Reuses the same repos as job-profit (jobRepo.findByCustomer is
  // required here); 503 when any is absent.
  router.get(
    '/customer-profit/:customerId',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (
          !deps.jobRepo?.findByCustomer ||
          !deps.invoiceRepo ||
          !deps.timeEntryRepo ||
          !deps.expenseRepo ||
          !deps.settingsRepo
        ) {
          res
            .status(503)
            .json({ error: 'NOT_CONFIGURED', message: 'Customer profit unavailable' });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const settings = await deps.settingsRepo.findByTenant(tenantId);
        const profit = await getCustomerProfit(
          {
            tenantId,
            customerId: req.params.customerId,
            laborRateCentsPerHour: settings?.laborRateCentsPerHour ?? null,
          },
          {
            // Pass the repo whole (preserves method `this`); the guard above
            // proved findByCustomer is present, which the cast asserts.
            jobRepo: deps.jobRepo as GetCustomerProfitDeps['jobRepo'],
            invoiceRepo: deps.invoiceRepo,
            timeEntryRepo: deps.timeEntryRepo,
            expenseRepo: deps.expenseRepo,
            ...(deps.materialsResolver ? { materialsResolver: deps.materialsResolver } : {}),
          },
        );
        res.json({ data: profit });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  // Technician profitability — aggregates per-job profit across the jobs
  // assigned to a technician. Same repos as customer-profit; jobRepo.findByTenant
  // is a required method (no narrowing/cast needed). 503 when any dep is absent.
  router.get(
    '/technician-profit/:technicianId',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (
          !deps.jobRepo ||
          !deps.invoiceRepo ||
          !deps.timeEntryRepo ||
          !deps.expenseRepo ||
          !deps.settingsRepo
        ) {
          res
            .status(503)
            .json({ error: 'NOT_CONFIGURED', message: 'Technician profit unavailable' });
          return;
        }
        const tenantId = req.auth!.tenantId;
        const settings = await deps.settingsRepo.findByTenant(tenantId);
        const profit = await getTechnicianProfit(
          {
            tenantId,
            technicianId: req.params.technicianId,
            laborRateCentsPerHour: settings?.laborRateCentsPerHour ?? null,
          },
          {
            jobRepo: deps.jobRepo,
            invoiceRepo: deps.invoiceRepo,
            timeEntryRepo: deps.timeEntryRepo,
            expenseRepo: deps.expenseRepo,
            ...(deps.materialsResolver ? { materialsResolver: deps.materialsResolver } : {}),
          },
        );
        res.json({ data: profit });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
