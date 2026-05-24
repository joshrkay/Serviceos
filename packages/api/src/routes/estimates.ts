import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createEstimateSchema } from '../shared/contracts';
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
  EstimateRepository,
  EstimateStatus,
  EstimateMutationDeps,
  DEFAULT_ESTIMATE_LIMIT,
  MAX_ESTIMATE_LIMIT,
} from '../estimates/estimate';
import { DocumentRevisionRepository } from '../ai/document-revision';
import { EditDeltaRepository } from '../estimates/edit-delta';
import { AuditRepository } from '../audit/audit';
import { getNextEstimateNumber, SettingsRepository } from '../settings/settings';
import { SendService } from '../notifications/send-service';
import { LLMGateway } from '../ai/gateway/gateway';
import { ProposalRepository } from '../proposals/proposal';
import { EstimateTaskHandler } from '../ai/tasks/estimate-task';
import { JobRepository } from '../jobs/job';
import { InvoiceRepository } from '../invoices/invoice';
import { RefreshJobMoneyStateDeps, refreshJobMoneyStateSafe } from '../jobs/job-money-state';
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
): Router {
  const router = Router();

  const jobRepo = moneyStateDeps?.jobRepo;

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
        // Cross-entity tenant guard: jobId must belong to the requesting tenant.
        await ownership.requireExists(req.auth!.tenantId, 'job', parsed.jobId);
        const estimateNumber = await getNextEstimateNumber(req.auth!.tenantId, settingsRepo);
        const result = await createEstimate(
          {
            ...parsed,
            tenantId: req.auth!.tenantId,
            estimateNumber,
            validUntil: parsed.validUntil ? new Date(parsed.validUntil) : undefined,
            createdBy: req.auth!.userId,
          },
          estimateRepo,
          auditRepo
        );
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
        const status = typeof req.query.status === 'string' ? req.query.status as EstimateStatus : undefined;
        const search = typeof req.query.search === 'string' ? req.query.search : undefined;
        const sort: 'asc' | 'desc' = req.query.sort === 'asc' ? 'asc' : 'desc';

        // Legacy single-job lookup: bare-array shape, no extra filters.
        // Preserves the existing UI contract for `?jobId=...` consumers.
        if (
          jobId &&
          status === undefined &&
          search === undefined &&
          req.query.paginated !== 'true' &&
          req.query.limit === undefined &&
          req.query.offset === undefined
        ) {
          const result = await estimateRepo.findByJob(req.auth!.tenantId, jobId);
          res.json(result);
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

        const baseOptions = { status, jobId, search, sort };

        if (wantsPaginated) {
          const result = await listEstimatesWithMeta(req.auth!.tenantId, estimateRepo, {
            ...baseOptions,
            limit,
            offset,
          });
          res.json(result);
          return;
        }

        const result = await listEstimates(req.auth!.tenantId, estimateRepo, baseOptions);
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

  const updateHandler = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const mutationDeps = await buildMutationDeps(req.auth!.tenantId, req.params.id, req);
      const result = await updateEstimate(
        req.auth!.tenantId,
        req.params.id,
        { ...req.body, expectedVersion: parseExpectedVersion(req) },
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
        const result = await reviseEstimate(
          req.auth!.tenantId,
          req.params.id,
          { ...req.body, expectedVersion: parseExpectedVersion(req) },
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

        const handler = new EstimateTaskHandler(aiDeps.gateway);
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
