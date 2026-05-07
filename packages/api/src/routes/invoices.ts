import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createInvoiceSchema } from '../shared/contracts';
import { TenantOwnership } from '../shared/tenant-ownership';
import {
  createInvoice,
  getInvoice,
  updateInvoice,
  issueInvoice,
  transitionInvoiceStatus,
  InvoiceRepository,
} from '../invoices/invoice';
import { AuditRepository } from '../audit/audit';
import { getNextInvoiceNumber, SettingsRepository } from '../settings/settings';

export function createInvoiceRouter(
  invoiceRepo: InvoiceRepository,
  settingsRepo: SettingsRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership
): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('invoices:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createInvoiceSchema.parse(req.body);
      await ownership.requireExists(req.auth!.tenantId, 'job', parsed.jobId);
      if (parsed.estimateId) {
        await ownership.requireExists(req.auth!.tenantId, 'estimate', parsed.estimateId);
      }
      const invoiceNumber = await getNextInvoiceNumber(req.auth!.tenantId, settingsRepo);
      const result = await createInvoice(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          invoiceNumber,
          createdBy: req.auth!.userId,
        },
        invoiceRepo,
        auditRepo
      );
      res.status(201).json(result);
    })
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await getInvoice(req.auth!.tenantId, req.params.id, invoiceRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice not found' });
        return;
      }
      res.json(result);
    })
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await updateInvoice(req.auth!.tenantId, req.params.id, req.body, invoiceRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice not found' });
        return;
      }
      res.json(result);
    })
  );

  router.post(
    '/:id/issue',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const paymentTermDays = req.body.paymentTermDays ?? 30;
      const result = await issueInvoice(req.auth!.tenantId, req.params.id, paymentTermDays, invoiceRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice not found' });
        return;
      }
      res.json(result);
    })
  );

  router.post(
    '/:id/transition',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const { status } = req.body;
      if (!status) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'status is required' });
        return;
      }
      const result = await transitionInvoiceStatus(req.auth!.tenantId, req.params.id, status, invoiceRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice not found' });
        return;
      }
      res.json(result);
    })
  );

  return router;
}
