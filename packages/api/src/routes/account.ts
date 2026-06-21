import { Router, Response } from 'express';
import type { Pool } from 'pg';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import type { Queue } from '../queues/queue';
import {
  DEPROVISION_TENANT_JOB_TYPE,
  type DeprovisionTenantPayload,
} from '../workers/deprovision-tenant';

export interface AccountRouterDeps {
  pool: Pool;
  queue: Queue;
}

/**
 * Self-serve account management for the signed-in owner.
 *
 * `POST /api/account/delete` is the in-app account-deletion path required by
 * Apple App Store Review Guideline 5.1.1(v): any app that supports account
 * creation must let the user delete their account from within the app.
 *
 * It enqueues the *same* `deprovision_tenant` job used by the platform-admin
 * route (Twilio release + full tenant-scoped DB purge), scoped to the caller's
 * own tenant — owners can only ever delete themselves. We return 202 because the
 * purge runs in the background worker; the client signs the user out immediately.
 */
export function createAccountRouter(deps: AccountRouterDeps): Router {
  const { pool, queue } = deps;
  const router = Router();

  router.post(
    '/delete',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = (req.body ?? {}) as { confirm?: boolean };
        if (body.confirm !== true) {
          res.status(400).json({
            error: 'CONFIRMATION_REQUIRED',
            message: 'Set confirm:true to acknowledge this permanently deletes your account',
          });
          return;
        }

        // requireTenant guarantees tenantId; assert for the type-checker and
        // fail closed if the invariant is ever broken.
        const tenantId = req.auth!.tenantId;
        if (!tenantId) {
          res.status(403).json({ error: 'FORBIDDEN', message: 'Tenant context required' });
          return;
        }

        // Idempotent: a tenant that's already gone purges to a no-op. We don't
        // 404 here — the owner asking to delete an account that's mid-purge
        // should still get a success-shaped response so the client signs out.
        const exists = await pool.query('SELECT id FROM tenants WHERE id = $1', [tenantId]);
        if (exists.rowCount === 0) {
          res.status(202).json({ enqueued: false, alreadyDeleted: true });
          return;
        }

        const payload: DeprovisionTenantPayload = {
          tenantId,
          reason: 'owner_self_serve',
          actorId: req.auth!.userId,
        };
        // Shares the admin path's idempotency key so a double-tap (or an
        // admin + owner racing the same tenant) collapses to one job.
        const jobId = await queue.send(
          DEPROVISION_TENANT_JOB_TYPE,
          payload,
          `deprovision-${tenantId}`,
        );

        res.status(202).json({ enqueued: true, jobId });
      } catch (error: unknown) {
        res.status(500).json({
          error: 'ACCOUNT_DELETE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to enqueue account deletion',
        });
      }
    },
  );

  return router;
}
