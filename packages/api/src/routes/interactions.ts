import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { DispatchRepository, DispatchEntityType, MessageDispatch } from '../notifications/dispatch-repository';
import { JobRepository } from '../jobs/job';
import { EstimateRepository } from '../estimates/estimate';
import { InvoiceRepository } from '../invoices/invoice';
import { toErrorResponse } from '../shared/errors';

export interface InteractionsRouterDeps {
  dispatchRepo: DispatchRepository;
  jobRepo?: JobRepository;
  estimateRepo?: EstimateRepository;
  invoiceRepo?: InvoiceRepository;
}

const VALID_ENTITY_TYPES = new Set<DispatchEntityType>([
  'estimate',
  'invoice',
  'appointment_confirmation',
  'delay_notice',
]);

/**
 * GET /api/interactions
 *
 * Returns a paginated list of all outbound message dispatches for the
 * authenticated tenant — SMS and email sends for estimates, invoices,
 * appointment confirmations, and delay notices.  Powers the /interactions
 * audit page (QA 9.1–9.4).
 *
 * Query params:
 *   limit       number  1–200, default 50
 *   offset      number  ≥0, default 0
 *   entityType  'estimate' | 'invoice' | 'appointment_confirmation' | 'delay_notice'
 *   customerId  UUID — filters to dispatches for this customer's entities
 */
export function createInteractionsRouter(deps: InteractionsRouterDeps | DispatchRepository): Router {
  // Support old single-arg signature for backwards compat with tests.
  const resolved: InteractionsRouterDeps =
    'listByTenant' in deps
      ? { dispatchRepo: deps }
      : deps;

  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;

        const rawLimit = req.query.limit as string | undefined;
        const rawOffset = req.query.offset as string | undefined;
        const rawEntityType = req.query.entityType as string | undefined;
        const rawCustomerId = req.query.customerId as string | undefined;

        const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 50;
        const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;

        if (Number.isNaN(limit) || limit < 1 || limit > 200) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'limit must be between 1 and 200' });
          return;
        }
        if (Number.isNaN(offset) || offset < 0) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'offset must be a non-negative integer' });
          return;
        }
        if (rawEntityType && !VALID_ENTITY_TYPES.has(rawEntityType as DispatchEntityType)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `entityType must be one of: ${[...VALID_ENTITY_TYPES].join(', ')}`,
          });
          return;
        }

        // Customer-scoped query: find all entity IDs (estimates + invoices) that
        // belong to this customer and then collect their dispatches.
        if (rawCustomerId && resolved.jobRepo?.findByCustomer && resolved.estimateRepo && resolved.invoiceRepo) {
          const jobs = await resolved.jobRepo.findByCustomer(tenantId, rawCustomerId);
          const entityDispatches: MessageDispatch[] = [];
          await Promise.all(
            jobs.map(async (job) => {
              const [ests, invs] = await Promise.all([
                resolved.estimateRepo!.findByJob(tenantId, job.id),
                resolved.invoiceRepo!.findByJob(tenantId, job.id),
              ]);
              const fetches = [
                ...ests.map((e) => resolved.dispatchRepo.findByEntity(tenantId, 'estimate', e.id)),
                ...invs.map((i) => resolved.dispatchRepo.findByEntity(tenantId, 'invoice', i.id)),
              ];
              const results = await Promise.all(fetches);
              results.forEach((ds) => entityDispatches.push(...ds));
            }),
          );
          entityDispatches.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
          const sliced = entityDispatches.slice(offset, offset + limit);
          res.json({ dispatches: sliced, total: entityDispatches.length, limit, offset });
          return;
        }

        const result = await resolved.dispatchRepo.listByTenant(tenantId, {
          limit,
          offset,
          entityType: rawEntityType as DispatchEntityType | undefined,
        });

        res.json({
          dispatches: result.dispatches,
          total: result.total,
          limit,
          offset,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
