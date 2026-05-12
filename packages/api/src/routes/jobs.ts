import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createJobSchema } from '../shared/contracts';
import { toErrorResponse, ValidationError } from '../shared/errors';
import { TenantOwnership } from '../shared/tenant-ownership';
import { Customer, CustomerRepository } from '../customers/customer';
import {
  createJob,
  getJob,
  updateJob,
  listJobs,
  listJobsWithMeta,
  JobRepository,
  DEFAULT_JOB_LIMIT,
  MAX_JOB_LIMIT,
} from '../jobs/job';
import {
  transitionJobStatus,
  JobTimelineRepository,
} from '../jobs/job-lifecycle';
import { AuditRepository } from '../audit/audit';
import { Queue } from '../queues/queue';
import { FeedbackDispatcher } from '../feedback/dispatcher';
import { LocationRepository, ServiceLocation } from '../locations/location';

export function createJobRouter(
  jobRepo: JobRepository,
  timelineRepo: JobTimelineRepository,
  auditRepo: AuditRepository,
  ownership: TenantOwnership,
  queue: Queue,
  feedbackDispatcher: FeedbackDispatcher,
  customerRepo?: CustomerRepository,
  locationRepo?: LocationRepository,
): Router {
  const router = Router();
  // Dispatcher is intentionally passed through router wiring so this API
  // surface aligns with app-level dependency injection for feedback_send.
  void feedbackDispatcher;

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('jobs:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createJobSchema.parse(req.body);
        // requireExistsAndLoad returns the row so we don't refetch it
        // below to read originatingLeadId for attribution propagation.
        const customer = (await ownership.requireExistsAndLoad(
          req.auth!.tenantId,
          'customer',
          parsed.customerId
        )) as Customer | undefined;
        const location = (await ownership.requireExistsAndLoad(
          req.auth!.tenantId,
          'location',
          parsed.locationId
        )) as ServiceLocation | undefined;
        if (location && location.customerId !== parsed.customerId) {
          throw new ValidationError('Service location does not belong to customer');
        }

        // Resolve source attribution: explicit body override wins;
        // otherwise inherit from the customer.
        let originatingLeadId = parsed.originatingLeadId;
        if (originatingLeadId) {
          await ownership.requireExists(req.auth!.tenantId, 'lead', originatingLeadId);
        } else {
          originatingLeadId = customer?.originatingLeadId;
        }

        const result = await createJob(
          {
            ...parsed,
            originatingLeadId,
            tenantId: req.auth!.tenantId,
            createdBy: req.auth!.userId,
            actorRole: req.auth!.role,
          },
          jobRepo,
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
    requirePermission('jobs:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const sort: 'asc' | 'desc' = req.query.sort === 'asc' ? 'asc' : 'desc';

        // P1-018: opt-in to `{ data, total }` shape via paginated/limit/offset.
        // Default keeps the legacy bare-array contract for older consumers.
        const wantsPaginated =
          req.query.paginated === 'true' ||
          req.query.limit !== undefined ||
          req.query.offset !== undefined;

        const limitRaw = req.query.limit as string | undefined;
        const offsetRaw = req.query.offset as string | undefined;
        const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : DEFAULT_JOB_LIMIT;
        const offset = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;
        if (limitRaw !== undefined && (Number.isNaN(limit) || limit < 1 || limit > MAX_JOB_LIMIT)) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `limit must be between 1 and ${MAX_JOB_LIMIT}`,
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

        const baseOptions = {
          status: req.query.status as any,
          customerId: req.query.customerId as string,
          technicianId: req.query.technicianId as string,
          search: req.query.search as string,
          sort,
        };

        if (wantsPaginated) {
          const result = await listJobsWithMeta(req.auth!.tenantId, jobRepo, {
            ...baseOptions,
            limit,
            offset,
          });
          res.json(result);
          return;
        }

        const result = await listJobs(req.auth!.tenantId, jobRepo, baseOptions);
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
    requirePermission('jobs:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getJob(req.auth!.tenantId, req.params.id, jobRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
          return;
        }

        // Enrich with customer and location data when repos are available
        let customer: Customer | null = null;
        let locations: Array<Record<string, unknown>> = [];
        if (result.customerId) {
          const [cust, locs] = await Promise.all([
            customerRepo ? customerRepo.findById(req.auth!.tenantId, result.customerId) : Promise.resolve(null),
            locationRepo ? locationRepo.findByCustomer(req.auth!.tenantId, result.customerId) : Promise.resolve([]),
          ]);
          customer = cust;
          locations = locs.map(loc => ({
            id: loc.id,
            street1: loc.street1,
            street2: loc.street2,
            city: loc.city,
            state: loc.state,
            postalCode: loc.postalCode,
            isPrimary: loc.isPrimary,
            label: loc.label,
          }));
        }

        const response = {
          ...result,
          customer: customer ? {
            id: customer.id,
            displayName: customer.displayName,
            firstName: customer.firstName,
            lastName: customer.lastName,
            primaryPhone: customer.primaryPhone,
            email: customer.email,
            communicationNotes: customer.communicationNotes,
            locations,
          } : undefined,
          location: locations.find(l => l.id === result.locationId),
        };

        res.json(response);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await updateJob(
          req.auth!.tenantId,
          req.params.id,
          req.body,
          jobRepo,
          req.auth!.userId,
          auditRepo
        );
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Job not found' });
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
    requirePermission('jobs:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { status } = req.body;
        if (!status) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'status is required' });
          return;
        }
        const result = await transitionJobStatus(
          req.auth!.tenantId,
          req.params.id,
          status,
          req.auth!.userId,
          req.auth!.role,
          jobRepo,
          timelineRepo,
          auditRepo
        );

        if (status === 'completed') {
          await queue.send(
            'feedback_send',
            { tenantId: req.auth!.tenantId, jobId: req.params.id },
            `${req.auth!.tenantId}:${req.params.id}:feedback_send`
          );
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
