import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createInvoiceSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
import { TenantOwnership } from '../shared/tenant-ownership';
import {
  createInvoice,
  listInvoices,
  getInvoice,
  updateInvoice,
  issueInvoice,
  transitionInvoiceStatus,
  InvoiceRepository,
} from '../invoices/invoice';
import { AuditRepository } from '../audit/audit';
import { getNextInvoiceNumber, SettingsRepository } from '../settings/settings';
import { PaymentRepository, recordPayment } from '../invoices/payment';

const nestedPaymentSchema = z.object({
  amountCents: z.number().int().positive(),
  method: z.enum(['cash', 'check', 'credit_card', 'bank_transfer', 'other']),
  providerReference: z.string().optional(),
  note: z.string().optional(),
});

export function createInvoiceRouter(
  invoiceRepo: InvoiceRepository,
  settingsRepo: SettingsRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership,
  paymentRepo?: PaymentRepository
): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('invoices:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createInvoiceSchema.parse(req.body);
        // Cross-entity tenant guard: jobId must belong to the
        // requesting tenant. estimateId is optional — guard it only
        // when present.
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
        const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
        const result = jobId
          ? await invoiceRepo.findByJob(req.auth!.tenantId, jobId)
          : await listInvoices(req.auth!.tenantId, invoiceRepo);
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getInvoice(req.auth!.tenantId, req.params.id, invoiceRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  const updateHandler = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await updateInvoice(req.auth!.tenantId, req.params.id, req.body, invoiceRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  };

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    updateHandler
  );

  router.patch(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    updateHandler
  );

  router.post(
    '/:id/issue',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const paymentTermDays = req.body.paymentTermDays ?? 30;
        const result = await issueInvoice(req.auth!.tenantId, req.params.id, paymentTermDays, invoiceRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/payment',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!paymentRepo) {
          res.status(501).json({
            error: 'NOT_IMPLEMENTED',
            message: 'Payment recording is not configured on this router',
          });
          return;
        }
        const parsed = nestedPaymentSchema.parse(req.body);
        const result = await recordPayment(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            invoiceId: req.params.id,
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

  router.post(
    '/:id/transition',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
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
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
