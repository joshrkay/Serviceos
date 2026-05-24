import { Router, Response, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { requirePlatformAdmin, PgPlatformAdminChecker } from '../auth/platform-admin';
import type { Queue } from '../queues/queue';
import {
  DEPROVISION_TENANT_JOB_TYPE,
  type DeprovisionTenantPayload,
} from '../workers/deprovision-tenant';
import type { DeprovisionReason } from '../tenants/deprovision';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminTenantsRouterDeps {
  pool: Pool;
  queue: Queue;
  /** Override for tests; otherwise built from a PgPlatformAdminChecker(pool). */
  requirePlatformAdmin?: RequestHandler;
}

export function createAdminTenantsRouter(deps: AdminTenantsRouterDeps): Router {
  const { pool, queue } = deps;
  const router = Router();

  const adminGuard =
    deps.requirePlatformAdmin ?? requirePlatformAdmin(new PgPlatformAdminChecker(pool));

  // Hard-delete a tenant. Platform-admin only. Enqueues the deprovision job
  // (Twilio release + full DB purge) and returns 202 — the purge runs in the
  // background worker.
  router.post(
    '/:tenantId/deprovision',
    requireAuth,
    requireTenant,
    adminGuard,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { tenantId } = req.params;
        if (!UUID_REGEX.test(tenantId)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'tenantId must be a UUID' });
          return;
        }

        const body = (req.body ?? {}) as {
          reason?: string;
          confirm?: boolean;
          force?: boolean;
        };
        if (body.confirm !== true) {
          res.status(400).json({
            error: 'CONFIRMATION_REQUIRED',
            message: 'Set confirm:true to acknowledge this is a permanent hard delete',
          });
          return;
        }

        const exists = await pool.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
        if (exists.rowCount === 0) {
          res.status(404).json({ error: 'TENANT_NOT_FOUND', message: 'No such tenant' });
          return;
        }

        const payload: DeprovisionTenantPayload = {
          tenantId,
          reason: (body.reason as DeprovisionReason) ?? 'manual_admin',
          actorId: req.auth!.userId,
          force: body.force === true,
        };
        const jobId = await queue.send(
          DEPROVISION_TENANT_JOB_TYPE,
          payload,
          `deprovision-${tenantId}`,
        );

        res.status(202).json({ enqueued: true, tenantId, jobId });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'DEPROVISION_ENQUEUE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to enqueue deprovision',
        });
      }
    },
  );

  return router;
}
