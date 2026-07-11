import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import {
  createEstimateSchema,
  updateEstimateSchema,
  verticalTypeSchema,
} from '../shared/contracts';
import {
  EstimateTemplateRepository,
  createTemplate,
  buildTemplateInputFromEstimate,
} from '../templates/estimate-template';
import { toErrorResponse } from '../shared/errors';
import { TenantOwnership } from '../shared/tenant-ownership';
import {
  createEstimate,
  listEstimates,
  listEstimatesWithMeta,
  getEstimate,
  updateEstimate,
  reviseEstimate,
  transitionEstimateStatus,
  softDeleteEstimate,
  cloneEstimate,
  EstimateRepository,
  EstimateStatus,
  EstimateMutationDeps,
  DEFAULT_ESTIMATE_LIMIT,
  MAX_ESTIMATE_LIMIT,
} from '../estimates/estimate';
import { DocumentRevisionRepository } from '../ai/document-revision';
import { EditDeltaRepository } from '../estimates/edit-delta';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { getNextEstimateNumber, SettingsRepository } from '../settings/settings';
import { SendService } from '../notifications/send-service';
import { LLMGateway } from '../ai/gateway/gateway';
import { ProposalRepository } from '../proposals/proposal';
import { EstimateTaskHandler } from '../ai/tasks/estimate-task';
import { CatalogItemRepository } from '../catalog/catalog-item';
import { JobRepository } from '../jobs/job';
import { InvoiceRepository } from '../invoices/invoice';
import { PaymentRepository } from '../invoices/payment';
import { convertEstimateToInvoice } from '../invoices/convert-estimate';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
import { applyBps } from '../shared/billing-engine';
import { AgreementRepository } from '../agreements/agreement';
import { getCustomerMemberDiscountBps } from '../agreements/member-pricing';
import { Customer, CustomerRepository } from '../customers/customer';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'estimates-route',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * Optimistic-concurrency version supplied by the client for an estimate
 * edit/revise. Read from the `If-Match` header (the convention the
 * proposals route uses) and falling back to a body `expectedVersion`.
 * Returns undefined when absent or malformed — the service then skips the
 * version check, preserving backward compatibility for callers that don't
 * participate in optimistic locking.
 */
function parseExpectedVersion(req: AuthenticatedRequest): number | undefined {
  const header = req.get?.('If-Match');
  const raw = header ?? (req.body as { expectedVersion?: unknown } | undefined)?.expectedVersion;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Optional AI dependencies. When provided, mounts POST /suggest, which
 * invokes EstimateTaskHandler to generate AI-suggested line items for
 * the in-app estimate wizard and pricing-review panel. When absent, the
 * /suggest route returns 503 so the FE can fall back to mock content
 * without breaking the wizard.
 */
export interface EstimateAIDeps {
  gateway: LLMGateway;
  proposalRepo: ProposalRepository;
  // Tenant catalog repo used to ground AI-suggested line-item prices to the
  // real catalog price (locked pattern: never trust an LLM-emitted price
  // without resolution). Wired through so /suggest grounds prices identically
  // to the voice path. Optional so legacy harnesses without a catalog still
  // build; when absent, every LLM price is treated as uncatalogued and the
  // confidence cap fires (see EstimateTaskHandler.groundLineItemPricing).
  catalogRepo?: CatalogItemRepository;
}

export function createEstimateRouter(
  estimateRepo: EstimateRepository,
  settingsRepo: SettingsRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership,
  sendService?: SendService,
  aiDeps?: EstimateAIDeps,
  // §6 Time-to-Cash. Optional so legacy harnesses still build; the
  // money-state rollup fires only when both repos are wired.
  moneyStateDeps?: { jobRepo: JobRepository; invoiceRepo: InvoiceRepository },
  // Edit/revision history. When wired, edits and revisions snapshot a
  // document revision + edit delta. Optional so legacy harnesses build.
  revisionDeps?: { docRevisionRepo: DocumentRevisionRepository; editDeltaRepo: EditDeltaRepository },
  // Convert-to-invoice deposit credit. Optional so legacy harnesses
  // build; when wired alongside moneyStateDeps the convert route credits
  // a paid deposit onto the new invoice.
  paymentRepo?: PaymentRepository,
  // Membership member-pricing (#6). When wired alongside the job repo, a new
  // estimate for a customer with an active discounting membership has that
  // discount folded in automatically. Optional so legacy harnesses build.
  agreementRepo?: AgreementRepository,
  // Estimate templates (#7.9). When wired, mounts POST /:id/save-as-template,
  // which turns an existing estimate into a reusable, tenant-scoped template.
  // Optional so legacy harnesses build (the route returns 503 when absent).
  templateRepo?: EstimateTemplateRepository,
  // Journey QA 2026-07-02 (bug 5) — list rows carry a customer summary
  // (resolved estimate → job → customer) so the UI stops rendering the
  // literal "Customer" fallback. Optional so legacy harnesses build.
  customerRepo?: CustomerRepository,
): Router {
  const router = Router();

  const jobRepo = moneyStateDeps?.jobRepo;

  /**
   * Journey QA 2026-07-02 (bug 5) — attach a customer summary to each list
   * row. Estimates carry only job_id, so this resolves estimate → job →
   * customer with deduplicated, page-bounded batches of lookups. Best-effort:
   * missing repos or rows leave the estimate unenriched.
   */
  const attachCustomerSummaries = async <T extends { jobId: string }>(
    tenantId: string,
    estimates: T[],
  ): Promise<Array<T & { customer?: Record<string, unknown> }>> => {
    if (!jobRepo || !customerRepo || estimates.length === 0) return estimates;
    const jobIds = [...new Set(estimates.map((e) => e.jobId).filter(Boolean))];
    const jobs = await Promise.all(
      jobIds.map((id) => jobRepo.findById(tenantId, id).catch(() => null)),
    );
    const jobById = new Map(jobs.filter((j) => j !== null).map((j) => [j!.id, j!]));
    const customerIds = [
      ...new Set(
        [...jobById.values()].map((j) => j.customerId).filter((id): id is string => !!id),
      ),
    ];
    const customers = await Promise.all(
      customerIds.map((id) => customerRepo.findById(tenantId, id).catch(() => null)),
    );
    const customerById = new Map(
      customers.filter((c): c is Customer => c !== null).map((c) => [c.id, c]),
    );
    return estimates.map((e) => {
      const job = jobById.get(e.jobId);
      const c = job?.customerId ? customerById.get(job.customerId) : undefined;
      return c
        ? {
            ...e,
            customer: {
              id: c.id,
              displayName: c.displayName,
              firstName: c.firstName,
              lastName: c.lastName,
            },
          }
        : e;
    });
  };

  // Build the per-request mutation deps (audit + revision history + the
  // deposit lock). The deposit-paid amount comes from the linked job so
  // assertEstimateEditable can refuse edits once money has been collected.
  const buildMutationDeps = async (
    tenantId: string,
    estimateId: string,
    req: AuthenticatedRequest,
  ): Promise<EstimateMutationDeps> => {
    let depositPaidCents = 0;
    if (jobRepo) {
      const est = await estimateRepo.findById(tenantId, estimateId);
      if (est) {
        const job = await jobRepo.findById(tenantId, est.jobId);
        depositPaidCents = job?.depositPaidCents ?? 0;
      }
    }
    return {
      auditRepo,
      docRevisionRepo: revisionDeps?.docRevisionRepo,
      editDeltaRepo: revisionDeps?.editDeltaRepo,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role ?? 'unknown',
      depositPaidCents,
      logger,
    };
  };

  // §6 Time-to-Cash. estimateRepo + auditRepo are already in scope;
  // the caller supplies the job + invoice repos.
  const refreshDeps: RefreshJobMoneyStateDeps | undefined = moneyStateDeps
    ? {
        jobRepo: moneyStateDeps.jobRepo,
        estimateRepo,
        invoiceRepo: moneyStateDeps.invoiceRepo,
        auditRepo,
        logger,
      }
    : undefined;

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createEstimateSchema.parse(req.body);
        const tenantId = req.auth!.tenantId;
        // Cross-entity tenant guard: jobId must belong to the requesting tenant.
        await ownership.requireExists(tenantId, 'job', parsed.jobId);
        const estimateNumber = await getNextEstimateNumber(tenantId, settingsRepo);

        // Member pricing (#6): fold an active membership's discount into this
        // estimate, additive to any manual discount. Resolved server-side from
        // the job's customer so the rate can't be spoofed by the client; a
        // best-effort enrichment that never blocks estimate creation.
        let discountCents = parsed.discountCents ?? 0;
        let memberDiscount: { bps: number; cents: number } | null = null;
        if (jobRepo && agreementRepo) {
          const job = await jobRepo.findById(tenantId, parsed.jobId);
          if (job) {
            const bps = await getCustomerMemberDiscountBps(tenantId, job.customerId, agreementRepo);
            if (bps > 0) {
              const subtotalCents = parsed.lineItems.reduce((sum, li) => sum + li.totalCents, 0);
              const cents = applyBps(subtotalCents, bps);
              if (cents > 0) {
                discountCents += cents;
                memberDiscount = { bps, cents };
              }
            }
          }
        }

        const result = await createEstimate(
          {
            ...parsed,
            discountCents,
            tenantId,
            estimateNumber,
            validUntil: parsed.validUntil ? new Date(parsed.validUntil) : undefined,
            createdBy: req.auth!.userId,
          },
          estimateRepo,
          auditRepo
        );

        // Provenance: record the auto-applied member discount distinctly from
        // the owner's manual discount (which is folded into the same total).
        if (memberDiscount) {
          await auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role ?? 'unknown',
              eventType: 'estimate.member_discount_applied',
              entityType: 'estimate',
              entityId: result.id,
              metadata: {
                memberDiscountBps: memberDiscount.bps,
                memberDiscountCents: memberDiscount.cents,
                jobId: parsed.jobId,
              },
            }),
          );
        }

        res.status(201).json(result);
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.error('[estimate-create] error:', err instanceof Error ? err.stack ?? err.message : String(err));
        }
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
        const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
        const status = typeof req.query.status === 'string' ? req.query.status as EstimateStatus : undefined;
        const search = typeof req.query.search === 'string' ? req.query.search : undefined;
        const sort: 'asc' | 'desc' = req.query.sort === 'asc' ? 'asc' : 'desc';

        // Legacy single-job lookup: bare-array shape, no extra filters.
        // Preserves the existing UI contract for `?jobId=...` consumers.
        if (
          jobId &&
          customerId === undefined &&
          status === undefined &&
          search === undefined &&
          req.query.paginated !== 'true' &&
          req.query.limit === undefined &&
          req.query.offset === undefined
        ) {
          const result = await estimateRepo.findByJob(req.auth!.tenantId, jobId);
          res.json(await attachCustomerSummaries(req.auth!.tenantId, result));
          return;
        }

        const wantsPaginated =
          req.query.paginated === 'true' ||
          req.query.limit !== undefined ||
          req.query.offset !== undefined;

        const limitRaw = req.query.limit as string | undefined;
        const offsetRaw = req.query.offset as string | undefined;
        const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_ESTIMATE_LIMIT;
        const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;
        if (limitRaw !== undefined && (Number.isNaN(limit) || limit < 1 || limit > MAX_ESTIMATE_LIMIT)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `limit must be between 1 and ${MAX_ESTIMATE_LIMIT}`,
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

        // Customer filter (Story 7.10). Estimates carry only job_id, so
        // translate a customerId into the customer's jobIds and filter on
        // those. Both queries are tenant-scoped (RLS + explicit tenant_id).
        let jobIds: string[] | undefined;
        if (customerId !== undefined) {
          if (!jobRepo?.findByCustomer) {
            res.status(400).json({
              error: 'VALIDATION_ERROR',
              message: 'Customer filtering is not available in this environment',
            });
            return;
          }
          const customerJobs = await jobRepo.findByCustomer(req.auth!.tenantId, customerId);
          jobIds = customerJobs.map((j) => j.id);
          if (jobIds.length === 0) {
            // The customer has no jobs → no estimates. Return the empty shape
            // matching the requested response form.
            res.json(wantsPaginated ? { data: [], total: 0 } : []);
            return;
          }
        }

        const baseOptions = { status, jobId, jobIds, search, sort };

        if (wantsPaginated) {
          const result = await listEstimatesWithMeta(req.auth!.tenantId, estimateRepo, {
            ...baseOptions,
            limit,
            offset,
          });
          res.json({
            ...result,
            data: await attachCustomerSummaries(req.auth!.tenantId, result.data),
          });
          return;
        }

        const result = await listEstimates(req.auth!.tenantId, estimateRepo, baseOptions);
        res.json(await attachCustomerSummaries(req.auth!.tenantId, result));
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
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getEstimate(req.auth!.tenantId, req.params.id, estimateRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // GET /:id/history — edit/revision history for the detail view (Story
  // 7.10). Returns the recorded edit deltas (what changed between persisted
  // versions) newest-last. 503 when the revision subsystem isn't wired.
  router.get(
    '/:id/history',
    requireAuth,
    requireTenant,
    requirePermission('estimates:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!revisionDeps?.editDeltaRepo) {
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message: 'Estimate history is not configured for this environment',
          });
          return;
        }
        // Tenant-ownership check: only surface history for an estimate the
        // caller can actually see.
        const estimate = await getEstimate(req.auth!.tenantId, req.params.id, estimateRepo);
        if (!estimate) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        const history = await revisionDeps.editDeltaRepo.findByEstimate(
          req.auth!.tenantId,
          req.params.id,
        );
        res.json(history);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  const updateHandler = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const mutationDeps = await buildMutationDeps(req.auth!.tenantId, req.params.id, req);
      const input = updateEstimateSchema.parse(req.body);
      const result = await updateEstimate(
        req.auth!.tenantId,
        req.params.id,
        { ...input, expectedVersion: parseExpectedVersion(req) },
        estimateRepo,
        mutationDeps,
      );
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
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
    requirePermission('estimates:update'),
    updateHandler
  );

  router.patch(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:update'),
    updateHandler
  );

  // POST /:id/revise — edit an already-SENT estimate. Snapshots the
  // prior version, bumps `version`, stamps `last_revised_at`, and keeps
  // the estimate in 'sent' (the view link is preserved). The caller is
  // expected to re-send (POST /:id/send) so the customer is re-notified;
  // the public approve path compares `version` to block a stale accept.
  router.post(
    '/:id/revise',
    requireAuth,
    requireTenant,
    requirePermission('estimates:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const mutationDeps = await buildMutationDeps(req.auth!.tenantId, req.params.id, req);
        const input = updateEstimateSchema.parse(req.body);
        const result = await reviseEstimate(
          req.auth!.tenantId,
          req.params.id,
          { ...input, expectedVersion: parseExpectedVersion(req) },
          estimateRepo,
          mutationDeps,
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // DELETE /:id — soft-delete an estimate. Accepted estimates are
  // refused (clone instead). Hidden from all reads afterward.
  router.delete(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('estimates:delete'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const mutationDeps = await buildMutationDeps(req.auth!.tenantId, req.params.id, req);
        const result = await softDeleteEstimate(
          req.auth!.tenantId,
          req.params.id,
          estimateRepo,
          mutationDeps,
          refreshDeps,
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        res.status(204).send();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // POST /:id/clone — copy an estimate into a fresh draft on the same
  // job (new estimate number, reset lifecycle). Returns the new draft.
  router.post(
    '/:id/clone',
    requireAuth,
    requireTenant,
    requirePermission('estimates:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const estimateNumber = await getNextEstimateNumber(req.auth!.tenantId, settingsRepo);
        const result = await cloneEstimate(
          req.auth!.tenantId,
          req.params.id,
          estimateNumber,
          req.auth!.userId,
          estimateRepo,
          auditRepo,
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // POST /:id/save-as-template — turn an existing estimate into a reusable,
  // tenant-scoped template (Story 7.9). The server fills the template's line
  // items, discount, tax rate, and customer message from the estimate; the
  // caller supplies the template's name + classification. The canonical
  // estimate is unchanged.
  const saveAsTemplateSchema = z.object({
    name: z.string().min(1).max(255),
    verticalType: verticalTypeSchema,
    categoryId: z.string().min(1),
    description: z.string().max(1000).optional(),
  });

  router.post(
    '/:id/save-as-template',
    requireAuth,
    requireTenant,
    requirePermission('estimates:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!templateRepo) {
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message: 'Estimate templates are not configured for this environment',
          });
          return;
        }
        const parsed = saveAsTemplateSchema.parse(req.body ?? {});
        const estimate = await getEstimate(req.auth!.tenantId, req.params.id, estimateRepo);
        if (!estimate) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        const template = await createTemplate(
          buildTemplateInputFromEstimate(estimate, {
            tenantId: req.auth!.tenantId,
            name: parsed.name,
            verticalType: parsed.verticalType,
            categoryId: parsed.categoryId,
            description: parsed.description,
            createdBy: req.auth!.userId,
          }),
          templateRepo,
          auditRepo,
          req.auth!.role ?? undefined,
        );
        res.status(201).json(template);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // POST /:id/convert-to-invoice — create a draft invoice from an
  // accepted estimate. Idempotent (returns the existing linked invoice on
  // re-call). Bills the customer's locked good-better-best selection and
  // credits any paid deposit. Also auto-expires the job's other open
  // estimates so only the converted one remains live.
  router.post(
    '/:id/convert-to-invoice',
    requireAuth,
    requireTenant,
    requirePermission('invoices:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!jobRepo || !moneyStateDeps) {
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message: 'Invoice conversion is not configured for this environment',
          });
          return;
        }
        const invoice = await convertEstimateToInvoice(req.auth!.tenantId, req.params.id, {
          estimateRepo,
          invoiceRepo: moneyStateDeps.invoiceRepo,
          jobRepo,
          settingsRepo,
          auditRepo,
          paymentRepo,
          moneyStateDeps: refreshDeps,
          actorId: req.auth!.userId,
          logger,
        });
        if (!invoice) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        // Auto-expire the job's other still-open (sent) estimates so the
        // converted one is the single live offer. Best-effort. The invoice
        // already carries the jobId and the source estimateId, so no extra
        // estimate lookup is needed. Money-state is refreshed once after the
        // loop rather than per sibling.
        try {
          const siblings = await estimateRepo.findByJob(req.auth!.tenantId, invoice.jobId);
          let expiredAny = false;
          for (const sib of siblings) {
            if (sib.id !== invoice.estimateId && sib.status === 'sent') {
              await transitionEstimateStatus(
                req.auth!.tenantId,
                sib.id,
                'expired',
                estimateRepo,
              );
              expiredAny = true;
              await auditRepo.create(
                createAuditEvent({
                  tenantId: req.auth!.tenantId,
                  actorId: req.auth!.userId,
                  actorRole: req.auth!.role ?? 'unknown',
                  eventType: 'estimate.expired',
                  entityType: 'estimate',
                  entityId: sib.id,
                  metadata: {
                    estimateNumber: sib.estimateNumber,
                    reason: 'sibling_converted',
                    convertedEstimateId: invoice.estimateId,
                  },
                }),
              );
            }
          }
          if (expiredAny && refreshDeps) {
            await refreshJobMoneyStateSafe(req.auth!.tenantId, invoice.jobId, req.auth!.userId, refreshDeps);
          }
        } catch (siblingErr) {
          logger.warn('estimate convert: sibling auto-expire failed', {
            estimateId: req.params.id,
            error: siblingErr instanceof Error ? siblingErr.message : String(siblingErr),
          });
        }
        res.status(201).json(invoice);
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
    requirePermission('estimates:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { status } = req.body;
        if (!status) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'status is required' });
          return;
        }
        const result = await transitionEstimateStatus(
          req.auth!.tenantId,
          req.params.id,
          status,
          estimateRepo,
          refreshDeps,
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Estimate not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // POST /suggest — invoke EstimateTaskHandler to generate AI line items
  // for the in-app wizard (NewEstimateFlow) and detail-page pricing
  // review. Persists the resulting proposal so the audit trail matches
  // the voice-agent flow (voice-action-router uses the same handler).
  // The FE consumes lineItems for immediate display; the proposalId lets
  // the wizard reference the underlying record on save.
  const suggestSchema = z.object({
    description: z.string().min(1).max(5000),
    serviceType: z.enum(['HVAC', 'Plumbing', 'Painting']).optional(),
    customerId: z.string().uuid().optional(),
    jobId: z.string().uuid().optional(),
    existingLineItems: z
      .array(
        z.object({
          description: z.string(),
          quantity: z.number(),
          unitPrice: z.number(),
        })
      )
      .max(50)
      .optional(),
  });

  router.post(
    '/suggest',
    requireAuth,
    requireTenant,
    requirePermission('estimates:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!aiDeps) {
          res.status(503).json({
            error: 'NOT_CONFIGURED',
            message: 'AI estimate suggestions are not configured for this environment',
          });
          return;
        }
        const parsed = suggestSchema.parse(req.body ?? {});

        if (parsed.jobId) {
          await ownership.requireExists(req.auth!.tenantId, 'job', parsed.jobId);
        }
        if (parsed.customerId) {
          await ownership.requireExists(req.auth!.tenantId, 'customer', parsed.customerId);
        }

        const handler = new EstimateTaskHandler(aiDeps.gateway, aiDeps.catalogRepo);
        const existingEntities: Record<string, unknown> = {};
        if (parsed.serviceType) existingEntities.serviceType = parsed.serviceType;
        if (parsed.customerId) existingEntities.customerId = parsed.customerId;
        if (parsed.jobId) existingEntities.jobId = parsed.jobId;
        if (parsed.existingLineItems) existingEntities.existingLineItems = parsed.existingLineItems;

        const result = await handler.handle({
          tenantId: req.auth!.tenantId,
          userId: req.auth!.userId,
          message: parsed.description,
          existingEntities: Object.keys(existingEntities).length > 0 ? existingEntities : undefined,
        });

        // EstimateTaskHandler hardcodes sourceTrustTier='autonomous' for the
        // voice-agent flow, which can auto-approve at ≥0.9 confidence and
        // gets picked up by runExecutionSweep. For UI suggestions the user
        // must explicitly commit — force draft so previewing a suggestion
        // never writes a real estimate to the database.
        const draftProposal = { ...result.proposal, status: 'draft' as const, approvedAt: undefined };
        const persisted = await aiDeps.proposalRepo.create(draftProposal);
        const payload = persisted.payload as {
          lineItems?: Array<{ description: string; quantity: number; unitPrice: number; category?: string }>;
          notes?: string;
        };

        res.status(200).json({
          proposalId: persisted.id,
          lineItems: payload.lineItems ?? [],
          notes: payload.notes,
          confidenceScore: persisted.confidenceScore,
          status: persisted.status,
        });
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
    requirePermission('estimates:update'),
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
          recipientPhone: z.string().optional().transform(v => v || undefined),
          recipientEmail: z.string().optional().transform(v => v || undefined),
          customMessage: z.string().optional().transform(v => v || undefined),
        }).safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid request body' });
          return;
        }
        const result = await sendService.sendEstimate({
          tenantId: req.auth!.tenantId,
          estimateId: req.params.id,
          ...parsed.data,
        });
        // §6 Time-to-Cash. sendEstimate transitions the estimate to
        // 'sent' inside SendService (not via transitionEstimateStatus),
        // so the rollup is triggered explicitly here. Best-effort.
        if (refreshDeps) {
          const sent = await estimateRepo.findById(req.auth!.tenantId, req.params.id);
          if (sent) {
            await refreshJobMoneyStateSafe(
              req.auth!.tenantId,
              sent.jobId,
              req.auth!.userId,
              refreshDeps,
            );
          }
        }
        res.status(202).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
