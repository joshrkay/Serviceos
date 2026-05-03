import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { EstimateRepository } from '../estimates/estimate';
import { JobRepository } from '../jobs/job';
import { InvoiceRepository } from '../invoices/invoice';
import { SettingsRepository } from '../settings/settings';
import { AuditRepository } from '../audit/audit';
import { convertEstimateToInvoice } from '../invoices/estimate-to-invoice';

/**
 * Cross-cutting estimate→invoice conversion endpoint.
 *
 * Lives on its own router so the main `createEstimateRouter` doesn't
 * grow yet another set of parameters; this one takes the four repos
 * it actually needs and mounts at the same `/api/estimates` path.
 *
 *   POST /api/estimates/:id/convert-to-invoice
 *     → 201 with the new (or existing, idempotent) invoice
 */
export function createEstimateConversionRouter(
  estimateRepo: EstimateRepository,
  jobRepo: JobRepository,
  invoiceRepo: InvoiceRepository,
  settingsRepo: SettingsRepository,
  auditRepo: AuditRepository,
): Router {
  const router = Router();

  router.post(
    '/:id/convert-to-invoice',
    requireAuth,
    requireTenant,
    requirePermission('invoices:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const invoice = await convertEstimateToInvoice(
          {
            tenantId: req.auth!.tenantId,
            estimateId: req.params.id,
            createdBy: req.auth!.userId,
          },
          estimateRepo,
          jobRepo,
          invoiceRepo,
          settingsRepo,
          auditRepo,
        );
        res.status(201).json(invoice);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
