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
import { routeParam } from '../shared/route-params';
import { asyncRoute } from '../middleware/async-route';
import { NotFoundError, ValidationError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { resolveUsageWindow, type TenantUsageRepository } from '../admin/tenant-usage';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminTenantsRouterDeps {
  pool: Pool;
  queue: Queue;
  usageRepo: TenantUsageRepository;
  /** Records each cross-tenant usage read (`admin.tenant_usage_viewed`). */
  auditRepo: AuditRepository;
  /** Clock for the default usage window; tests pin it. */
  now?: () => Date;
  /** Override for tests; otherwise built from a PgPlatformAdminChecker(pool). */
  requirePlatformAdmin?: RequestHandler;
}

export function createAdminTenantsRouter(deps: AdminTenantsRouterDeps): Router {
  const { pool, queue, usageRepo, auditRepo } = deps;
  const now = deps.now ?? (() => new Date());
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
        const tenantId = routeParam(req, 'tenantId');
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

  // Read-only usage report for one tenant over [from, to) — AI runs/tokens/
  // cost, voice calls/minutes/provider cost, audit activity, user count.
  // Platform-admin only (a tenant owner gets 403 even for their own tenant).
  // The reads run under the TARGET tenant's RLS context (see
  // admin/pg-tenant-usage.ts). Each successful read is audited under the
  // acting admin's home tenant with scope 'platform' — the same convention as
  // the feature-flag admin mutations — and the audit write commits with the
  // request transaction; if it fails the report is not returned.
  router.get(
    '/:tenantId/usage',
    requireAuth,
    requireTenant,
    adminGuard,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = routeParam(req, 'tenantId');
      if (!UUID_REGEX.test(tenantId)) {
        throw new ValidationError('tenantId must be a UUID');
      }
      const window = resolveUsageWindow(req.query, now());

      const report = await usageRepo.getUsage(tenantId, window);
      if (!report) throw new NotFoundError('Tenant', tenantId);

      await auditRepo.create(
        createAuditEvent({
          tenantId: req.auth!.tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'admin.tenant_usage_viewed',
          entityType: 'tenant',
          entityId: tenantId,
          metadata: {
            scope: 'platform',
            targetTenantId: tenantId,
            from: report.window.from,
            to: report.window.to,
          },
        }),
      );

      res.json(report);
    }),
  );

  return router;
}
