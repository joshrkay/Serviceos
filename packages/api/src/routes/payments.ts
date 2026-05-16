import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { recordPaymentSchema } from '../shared/contracts';
import { recordPayment, getPaymentsByInvoice, PaymentRepository } from '../invoices/payment';
import { InvoiceRepository } from '../invoices/invoice';
import { JobRepository } from '../jobs/job';
import { EstimateRepository } from '../estimates/estimate';
import { AuditRepository } from '../audit/audit';
import { RefreshJobMoneyStateDeps } from '../jobs/job-money-state';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'payments-route',
  environment: process.env.NODE_ENV || 'development',
});

export function createPaymentRouter(
  paymentRepo: PaymentRepository,
  invoiceRepo: InvoiceRepository,
  // §6 Time-to-Cash. Optional so legacy harnesses still build; the
  // money-state rollup fires only when jobRepo + estimateRepo are wired.
  jobRepo?: JobRepository,
  estimateRepo?: EstimateRepository,
  auditRepo?: AuditRepository,
): Router {
  const router = Router();

  // §6 Time-to-Cash. Two-dep guard is sufficient because invoiceRepo is
  // a required positional param of this router (always defined); the
  // handler registry's three-dep guard makes invoiceRepo's check explicit
  // because its registry deps treat invoiceRepo as optional.
  // Built once at factory time; logger is included so a rollup failure
  // is logged (not silently swallowed) at this call site.
  const refreshDeps: RefreshJobMoneyStateDeps | undefined =
    jobRepo && estimateRepo
      ? { jobRepo, estimateRepo, invoiceRepo, auditRepo, logger }
      : undefined;

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = recordPaymentSchema.parse(req.body);
      const result = await recordPayment(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          processedBy: req.auth!.userId,
        },
        invoiceRepo,
        paymentRepo,
        refreshDeps,
      );
      res.status(201).json(result);
    })
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const invoiceId = req.query.invoiceId as string;
      if (!invoiceId) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'invoiceId query parameter is required' });
        return;
      }
      const result = await getPaymentsByInvoice(req.auth!.tenantId, invoiceId, paymentRepo);
      res.json(result);
    })
  );

  return router;
}
