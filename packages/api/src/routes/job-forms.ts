import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import {
  JobFormRepository,
  archiveJobFormTemplate,
  createJobFormSubmission,
  createJobFormTemplate,
  updateJobFormSubmission,
  updateJobFormTemplate,
} from '../job-forms/job-form';
import {
  createJobFormSubmissionSchema,
  createJobFormTemplateSchema,
  updateJobFormSubmissionSchema,
  updateJobFormTemplateSchema,
} from '../shared/contracts';

/**
 * J-FORM (Jobber parity) — job forms & checklists.
 *
 * Mounted at /api/job-forms. Template management (create/edit/archive) is a
 * settings-level operation (`settings:update`); reading templates and
 * filling/completing submissions is field work (`jobs:view` / `jobs:update`)
 * so technicians can use them on a job.
 */
export function createJobFormRouter(
  jobFormRepo: JobFormRepository,
  auditRepo: AuditRepository
): Router {
  const router = Router();

  // --- Templates -----------------------------------------------------------

  router.get(
    '/templates',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const includeArchived = req.query.includeArchived === 'true';
      const templates = await jobFormRepo.listTemplates(req.auth!.tenantId, includeArchived);
      res.json(templates);
    })
  );

  router.get(
    '/templates/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const template = await jobFormRepo.findTemplateById(req.auth!.tenantId, req.params.id);
      if (!template) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job form template not found' });
        return;
      }
      res.json(template);
    })
  );

  router.post(
    '/templates',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createJobFormTemplateSchema.parse(req.body);
      const template = await createJobFormTemplate(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        jobFormRepo,
        auditRepo
      );
      res.status(201).json(template);
    })
  );

  router.patch(
    '/templates/:id',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = updateJobFormTemplateSchema.parse(req.body);
      const template = await updateJobFormTemplate(
        req.auth!.tenantId,
        req.params.id,
        parsed,
        jobFormRepo,
        req.auth!.userId,
        auditRepo,
        req.auth!.role
      );
      res.json(template);
    })
  );

  router.post(
    '/templates/:id/archive',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const archived = await archiveJobFormTemplate(
        req.auth!.tenantId,
        req.params.id,
        jobFormRepo,
        req.auth!.userId,
        auditRepo,
        req.auth!.role
      );
      if (!archived) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job form template not found' });
        return;
      }
      res.json(archived);
    })
  );

  // --- Submissions (per job) ----------------------------------------------

  router.get(
    '/jobs/:jobId/submissions',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const submissions = await jobFormRepo.listSubmissionsByJob(
        req.auth!.tenantId,
        req.params.jobId
      );
      res.json(submissions);
    })
  );

  router.post(
    '/jobs/:jobId/submissions',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createJobFormSubmissionSchema.parse(req.body);
      const submission = await createJobFormSubmission(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          jobId: req.params.jobId,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        jobFormRepo,
        auditRepo
      );
      res.status(201).json(submission);
    })
  );

  router.get(
    '/submissions/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const submission = await jobFormRepo.findSubmissionById(req.auth!.tenantId, req.params.id);
      if (!submission) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Job form submission not found' });
        return;
      }
      res.json(submission);
    })
  );

  router.patch(
    '/submissions/:id',
    requireAuth,
    requireTenant,
    requirePermission('jobs:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = updateJobFormSubmissionSchema.parse(req.body);
      const submission = await updateJobFormSubmission(
        req.auth!.tenantId,
        req.params.id,
        parsed,
        jobFormRepo,
        req.auth!.userId,
        auditRepo,
        req.auth!.role
      );
      res.json(submission);
    })
  );

  return router;
}
