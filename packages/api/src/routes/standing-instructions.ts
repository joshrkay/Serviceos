import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import {
  StandingInstructionRepository,
  createStandingInstruction,
  createStandingInstructionSchema,
  deactivateStandingInstruction,
} from '../instructions/standing-instructions';

/**
 * UB-A1 (agent wave) — standing instructions management.
 *
 * Mounted at /api/standing-instructions. Tenant-level agent settings, so the
 * settings permission set gates it. Creation here is always source
 * 'settings'; the proposal-gated voice on-ramp (source 'proposal') arrives in
 * a later unit. Deactivation is soft — no hard delete — so instructions that
 * influenced past drafts stay auditable.
 */
export function createStandingInstructionRouter(
  repo: StandingInstructionRepository,
  auditRepo: AuditRepository
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const activeOnly = req.query.active === 'true';
      const tenantId = req.auth!.tenantId;
      res.json(activeOnly ? await repo.listActive(tenantId) : await repo.listAll(tenantId));
    })
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createStandingInstructionSchema.parse(req.body);
      const created = await createStandingInstruction(
        {
          tenantId: req.auth!.tenantId,
          instruction: parsed.instruction,
          scope: parsed.scope,
          source: 'settings',
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        repo,
        auditRepo
      );
      res.status(201).json(created);
    })
  );

  router.patch(
    '/:id/deactivate',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const deactivated = await deactivateStandingInstruction(
        req.auth!.tenantId,
        req.params.id,
        repo,
        req.auth!.userId,
        auditRepo,
        req.auth!.role
      );
      res.json(deactivated);
    })
  );

  return router;
}
