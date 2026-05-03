import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createInvoiceSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
import { TenantOwnership } from '../shared/tenant-ownership';
import {
  createInvoiceWithNextNumber,
  listInvoices,
  listInvoicesWithMeta,
  getInvoice,
  updateInvoice,
  issueInvoice,
  transitionInvoiceStatus,
  InvoiceRepository,
  InvoiceStatus,
  DEFAULT_INVOICE_LIMIT,
  MAX_INVOICE_LIMIT,
} from '../invoices/invoice';
import { AuditRepository } from '../audit/audit';
import { SettingsRepository } from '../settings/settings';
import { PaymentRepository, recordPayment } from '../invoices/payment';
import { SendService } from '../notifications/send-service';
import { Job } from '../jobs/job';

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
  paymentRepo?: PaymentRepository,
  sendService?: SendService,
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
        // Cross-entity tenant guard + load: requireExistsAndLoad returns
        // the job so we can read originatingLeadId for attribution
        // propagation without a second findById round-trip.
        const job = (await ownership.requireExistsAndLoad(
          req.auth!.tenantId,
          'job',
          parsed.jobId
        )) as Job | undefined;
        if (parsed.estimateId) {
          await ownership.requireExists(req.auth!.tenantId, 'estimate', parsed.estimateId);
        }

        const result = await createInvoiceWithNextNumber(
          {
            ...parsed,
            originatingLeadId: job?.originatingLeadId,
            tenantId: req.auth!.tenantId,
            createdBy: req.auth!.userId,
          },
          invoiceRepo,
          settingsRepo,
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
        const status = typeof req.query.status === 'string' ? req.query.status as InvoiceStatus : undefined;
        const search = typeof req.query.search === 'string' ? req.query.search : undefined;
        const sort: 'asc' | 'desc' = req.query.sort === 'asc' ? 'asc' : 'desc';

        // P1-018 — date range filters: dueAfter / dueBefore (ISO).
        const dueAfter = typeof req.query.dueAfter === 'string' ? req.query.dueAfter : undefined;
        const dueBefore = typeof req.query.dueBefore === 'string' ? req.query.dueBefore : undefined;
        const fromDueDate = dueAfter ? new Date(dueAfter) : undefined;
        const toDueDate = dueBefore ? new Date(dueBefore) : undefined;
        if (fromDueDate && Number.isNaN(fromDueDate.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'dueAfter must be a valid ISO date' });
          return;
        }
        if (toDueDate && Number.isNaN(toDueDate.getTime())) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'dueBefore must be a valid ISO date' });
          return;
        }

        // Legacy single-job lookup still returns the bare array shape so
        // existing UI code continues to work without an opt-in.
        if (jobId && req.query.paginated !== 'true' && req.query.limit === undefined && req.query.offset === undefined) {
          const result = await invoiceRepo.findByJob(req.auth!.tenantId, jobId);
          res.json(result);
          return;
        }

        const wantsPaginated =
          req.query.paginated === 'true' ||
          req.query.limit !== undefined ||
          req.query.offset !== undefined;

        const limitRaw = req.query.limit as string | undefined;
        const offsetRaw = req.query.offset as string | undefined;
        const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_INVOICE_LIMIT;
        const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;
        if (limitRaw !== undefined && (Number.isNaN(limit) || limit < 1 || limit > MAX_INVOICE_LIMIT)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `limit must be between 1 and ${MAX_INVOICE_LIMIT}`,
          });
          return;
        }
        if (offsetRaw !== undefined && (Number.isNaN(offset) || offset < 0)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'offset must be a non-negative integer',
          });
          return;
        }

        const baseOptions = { status, jobId, search, fromDueDate, toDueDate, sort } as const;

        if (wantsPaginated) {
          const result = await listInvoicesWithMeta(req.auth!.tenantId, invoiceRepo, {
            ...baseOptions,
            limit,
            offset,
          });
          res.json(result);
          return;
        }

        const result = await listInvoices(req.auth!.tenantId, invoiceRepo, baseOptions);
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

  router.post(
    '/:id/send',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!sendService) {
          res
            .status(503)
            .json({
              error: 'NOT_CONFIGURED',
              message: 'Message delivery is not configured for this environment',
            });
          return;
        }
        const parsed = z.object({
          channel: z.enum(['sms', 'email', 'both']).default('sms'),
          recipientPhone: z.string().optional(),
          recipientEmail: z.string().optional(),
          customMessage: z.string().optional(),
        }).safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid request body' });
          return;
        }
        const result = await sendService.sendInvoice({
          tenantId: req.auth!.tenantId,
          invoiceId: req.params.id,
          ...parsed.data,
        });
        res.status(202).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
