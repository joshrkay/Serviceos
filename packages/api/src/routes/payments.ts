import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { recordPaymentSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
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
    async (req: AuthenticatedRequest, res: Response) => {
      try {
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
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const invoiceId = req.query.invoiceId as string;
        if (!invoiceId) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'invoiceId query parameter is required' });
          return;
        }
        const result = await getPaymentsByInvoice(req.auth!.tenantId, invoiceId, paymentRepo);
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
