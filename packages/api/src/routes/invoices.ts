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
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { SettingsRepository } from '../settings/settings';
import { PaymentRepository, recordPayment } from '../invoices/payment';
import { applyDepositCreditToInvoice } from '../invoices/deposit-credit';
import { SendService } from '../notifications/send-service';
import { Job, JobRepository } from '../jobs/job';
import { EstimateRepository } from '../estimates/estimate';
import { RefreshJobMoneyStateDeps } from '../jobs/job-money-state';
import { applyBps } from '../shared/billing-engine';
import { AgreementRepository } from '../agreements/agreement';
import { getCustomerMemberDiscountBps } from '../agreements/member-pricing';
import { createLogger } from '../logging/logger';
import { PaymentLinkProvider } from '../payments/payment-link-provider';
import { createInvoicePaymentLink } from '../invoices/invoice-payment-link';

const logger = createLogger({
  service: 'invoices-route',
  environment: process.env.NODE_ENV || 'development',
});

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
  // Tier 4 (Deposit rules — PR 3c). Optional so legacy harnesses
  // without a job repo still build the router; deposit credit only
  // fires when both jobRepo + paymentRepo are wired.
  jobRepo?: JobRepository,
  // §6 Time-to-Cash. Optional so legacy harnesses still build; the
  // money-state rollup fires only when both jobRepo + estimateRepo
  // are wired.
  estimateRepo?: EstimateRepository,
  paymentLinkProvider?: PaymentLinkProvider,
  // Membership member-pricing (#6). When wired, a DIRECT invoice (not one
  // converted from an estimate, which already carries the discount) for a
  // member has that discount folded in. Optional so legacy harnesses build.
  agreementRepo?: AgreementRepository,
): Router {
  const router = Router();

  // §6 Time-to-Cash. Built once at factory time — the rollup needs the
  // job, estimate and invoice repos plus the audit repo for the
  // job.money_state_changed event.
  const refreshDeps: RefreshJobMoneyStateDeps | undefined =
    jobRepo && estimateRepo
      ? { jobRepo, estimateRepo, invoiceRepo, auditRepo, logger }
      : undefined;

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

        // Member pricing (#6): fold an active membership's discount into a
        // DIRECT invoice. Skipped when converting from an estimate — that
        // estimate already had the discount applied, so re-applying here would
        // double it. Resolved server-side; additive to any manual discount.
        let discountCents = parsed.discountCents ?? 0;
        let memberDiscount: { bps: number; cents: number } | null = null;
        if (!parsed.estimateId && agreementRepo) {
          // Prefer the job already loaded by the ownership guard; fall back to
          // the repo (the permissive test guard doesn't return the row).
          const memberJob =
            job ?? (jobRepo ? await jobRepo.findById(req.auth!.tenantId, parsed.jobId) : undefined);
          const bps = memberJob
            ? await getCustomerMemberDiscountBps(req.auth!.tenantId, memberJob.customerId, agreementRepo)
            : 0;
          if (bps > 0) {
            const subtotalCents = parsed.lineItems.reduce((sum, li) => sum + li.totalCents, 0);
            const cents = applyBps(subtotalCents, bps);
            if (cents > 0) {
              discountCents += cents;
              memberDiscount = { bps, cents };
            }
          }
        }

        const result = await createInvoiceWithNextNumber(
          {
            ...parsed,
            discountCents,
            originatingLeadId: job?.originatingLeadId,
            tenantId: req.auth!.tenantId,
            createdBy: req.auth!.userId,
          },
          invoiceRepo,
          settingsRepo,
          auditRepo
        );

        if (memberDiscount) {
          await auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role ?? 'unknown',
              eventType: 'invoice.member_discount_applied',
              entityType: 'invoice',
              entityId: result.id,
              metadata: {
                memberDiscountBps: memberDiscount.bps,
                memberDiscountCents: memberDiscount.cents,
                jobId: parsed.jobId,
              },
            }),
          );
        }

        // Tier 4 (Deposit rules — PR 3c). When the linked job has a
        // paid deposit that hasn't been credited to any invoice yet,
        // apply it as a system payment + reduce amountDue on this
        // invoice. No-op when the deposit is 0, already-consumed, or
        // when the deps haven't been wired (legacy harnesses). Failure
        // here must NOT bounce the invoice creation — we already
        // returned the invoice number and the customer expects a
        // record. Surface as a structured log + an audit event so
        // dispatch can reconcile manually.
        let credited = result;
        if (jobRepo && paymentRepo && job) {
          try {
            const credit = await applyDepositCreditToInvoice(
              result,
              job,
              invoiceRepo,
              paymentRepo,
              jobRepo,
            );
            if (credit) credited = credit.invoice;
          } catch (creditErr) {
            // Best-effort. Invoice exists with the right total; the
            // unconsumed deposit stays on the job and operations can
            // apply it manually if this hook misfires repeatedly.
            //
            // CRITICAL: the audit-write below ALSO has to be best-effort.
            // A storage hiccup must not flip a successful invoice
            // creation to a 500 — the client would retry and create a
            // duplicate invoice (a separate row, since the first
            // POST already returned a real id). PR 319 review feedback.
            const message = creditErr instanceof Error ? creditErr.message : String(creditErr);
            try {
              await auditRepo.create(
                createAuditEvent({
                  tenantId: req.auth!.tenantId,
                  actorId: req.auth!.userId,
                  actorRole: 'system',
                  eventType: 'invoice.deposit_credit_failed',
                  entityType: 'invoice',
                  entityId: result.id,
                  metadata: { jobId: job.id, error: message },
                }),
              );
            } catch {
              // Audit write failure cannot block the response — the
              // invoice is real and the client should see it.
            }
          }
        }
        res.status(201).json(credited);
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

        // Customer filter (US-069). Invoices carry only job_id, so translate a
        // customerId into the customer's jobIds and return invoices for those
        // jobs. Uses existing repo methods (findByCustomer + findByJobs) — no
        // new SQL. Returns the bare-array shape like the legacy jobId lookup;
        // the CustomerDetail records panel consumes it directly. Optional
        // status filter is applied in-memory; results sorted newest-first.
        const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
        if (customerId) {
          if (!jobRepo?.findByCustomer) {
            res.status(400).json({
              error: 'VALIDATION_ERROR',
              message: 'Customer filtering is not available in this environment',
            });
            return;
          }
          const customerJobs = await jobRepo.findByCustomer(req.auth!.tenantId, customerId);
          const jobIds = customerJobs.map((j) => j.id);
          if (jobIds.length === 0) {
            res.json([]);
            return;
          }
          let invoices = await invoiceRepo.findByJobs(req.auth!.tenantId, jobIds);
          if (status) invoices = invoices.filter((inv) => inv.status === status);
          invoices.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          res.json(invoices);
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
    '/:id/payment-link',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!paymentLinkProvider) {
          res.status(501).json({
            error: 'NOT_CONFIGURED',
            message: 'Payment link provider is not configured on this router',
          });
          return;
        }
        const result = await createInvoicePaymentLink(
          req.auth!.tenantId,
          req.params.id,
          invoiceRepo,
          paymentLinkProvider,
        );
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/:id/issue',
    requireAuth,
    requireTenant,
    requirePermission('invoices:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const paymentTermDays = req.body.paymentTermDays ?? 30;
        const result = await issueInvoice(
          req.auth!.tenantId,
          req.params.id,
          paymentTermDays,
          invoiceRepo,
          refreshDeps,
        );
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
          paymentRepo,
          refreshDeps,
          undefined,
          auditRepo,
          { actorRole: req.auth!.role },
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
        const result = await transitionInvoiceStatus(
          req.auth!.tenantId,
          req.params.id,
          status,
          invoiceRepo,
          refreshDeps,
        );
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
        // ''→undefined mirrors the estimates send route: the send sheet posts
        // empty strings for untouched fields, and SendService must fall back
        // to the customer's contact on file instead of failing on ''
        // (journey QA 2026-07-02, bug 2).
        const parsed = z.object({
          channel: z.enum(['sms', 'email', 'both']).default('sms'),
          recipientPhone: z.string().optional().transform(v => v || undefined),
          recipientEmail: z.string().optional().transform(v => v || undefined),
          customMessage: z.string().optional().transform(v => v || undefined),
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
        // §6 Time-to-Cash. `sendInvoice` only stamps `sentAt`/`lastDispatchId`;
        // it does NOT transition the invoice's status. The job's money-state
        // (driven by `status`/`dueDate`) is therefore unchanged at send time,
        // so no rollup call is needed here — unlike the estimate `/send` route,
        // where SendService transitions the estimate to 'sent' internally.
        res.status(202).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
