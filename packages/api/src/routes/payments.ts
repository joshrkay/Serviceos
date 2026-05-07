import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { recordPaymentSchema } from '../shared/contracts';
import { recordPayment, getPaymentsByInvoice, PaymentRepository } from '../invoices/payment';
import { InvoiceRepository } from '../invoices/invoice';

export function createPaymentRouter(
  paymentRepo: PaymentRepository,
  invoiceRepo: InvoiceRepository
): Router {
  const router = Router();

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
        paymentRepo
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
