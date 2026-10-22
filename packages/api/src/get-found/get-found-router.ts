/**
 * #1750 (D-044) — the Get found online checklist.
 *
 * Mounted at /api/get-found. The checklist is derived on every read from
 * facts (`loadGetFoundFacts` → `deriveGetFoundChecklist`); nothing here
 * stores an item's status.
 *
 *   GET    /                 → the checklist
 *   PUT    /presence-path    → the owner's "do you have a website?" answer
 *   PUT    /forwarding-mode  → missed calls only / all calls; a real change voids the last forwarding check
 *   PUT    /items/:id/skip   → fold an item into the hidden row (idempotent)
 *   DELETE /items/:id/skip   → bring it back
 *
 * Every write emits an audit event and answers with the re-derived checklist.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { currentTenantContext } from '../middleware/tenant-context';
import { toErrorResponse } from '../shared/errors';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import { ensureTenantSettings, type SettingsRepository } from '../settings/settings';
import { GET_FOUND_ITEM_IDS, deriveGetFoundChecklist } from './derive-checklist';
import { loadGetFoundFacts } from './load-facts';

export interface GetFoundRouterDeps {
  pool: Pool;
  settingsRepo: SettingsRepository;
  auditRepo: AuditRepository;
}

const presencePathSchema = z.object({
  presencePath: z.enum(['own_website', 'google_only', 'neither']),
});

const itemParamsSchema = z.object({ id: z.enum(GET_FOUND_ITEM_IDS) });

const forwardingModeSchema = z.object({
  forwardingMode: z.enum(['missed_calls', 'all_calls']),
});

export function createGetFoundRouter(deps: GetFoundRouterDeps): Router {
  const router = Router();
  // The request's tenant-bound client under /api; the raw pool in tests.
  const db = () => currentTenantContext()?.client ?? deps.pool;

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const facts = await loadGetFoundFacts(db(), req.auth!.tenantId);
        res.json(deriveGetFoundChecklist(facts));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /** Every write: audit it, then answer with the re-derived checklist. */
  async function auditAndRespond(
    req: AuthenticatedRequest,
    res: Response,
    eventType: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const { tenantId, userId, role } = req.auth!;
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: userId,
        actorRole: role,
        eventType,
        entityType: 'get_found',
        entityId: tenantId,
        metadata,
      }),
    );
    res.json(deriveGetFoundChecklist(await loadGetFoundFacts(db(), tenantId)));
  }

  router.put(
    '/presence-path',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { presencePath } = presencePathSchema.parse(req.body ?? {});
        const { tenantId } = req.auth!;
        await ensureTenantSettings(tenantId, deps.settingsRepo);
        const { rows } = await db().query<{ previous: string | null }>(
          `UPDATE tenant_settings ts SET presence_path = $2, updated_at = NOW()
             FROM (SELECT presence_path AS previous FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE) old
            WHERE ts.tenant_id = $1
            RETURNING old.previous`,
          [tenantId, presencePath],
        );
        await auditAndRespond(req, res, 'get_found.presence_path.set', {
          presencePath,
          previous: rows[0]?.previous ?? null,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * D-044: a forwarding check is point-in-time proof for one mode. A real
   * mode change clears it and advances the line's `forwarding_generation`
   * (migration 318), so a check still in flight for the old mode cannot
   * stamp the new one. NULL reads as the default, missed calls only.
   */
  router.put(
    '/forwarding-mode',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { forwardingMode } = forwardingModeSchema.parse(req.body ?? {});
        const { tenantId } = req.auth!;
        await ensureTenantSettings(tenantId, deps.settingsRepo);
        const { rows } = await db().query<{ previous: string }>(
          `UPDATE tenant_settings ts
              SET forwarding_mode = $2,
                  forwarding_verified_at = NULL,
                  forwarding_generation = ts.forwarding_generation + 1,
                  updated_at = NOW()
             FROM (SELECT COALESCE(forwarding_mode, 'missed_calls') AS previous
                     FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE) old
            WHERE ts.tenant_id = $1 AND old.previous <> $2
            RETURNING old.previous`,
          [tenantId, forwardingMode],
        );
        if (rows.length > 0) {
          await auditAndRespond(req, res, 'get_found.forwarding_mode.set', {
            forwardingMode,
            previous: rows[0].previous,
          });
        } else {
          res.json(deriveGetFoundChecklist(await loadGetFoundFacts(db(), tenantId)));
        }
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  function skipRoute(method: 'put' | 'delete') {
    router[method](
      '/items/:id/skip',
      requireAuth,
      requireTenant,
      requirePermission('settings:update'),
      async (req: AuthenticatedRequest, res: Response) => {
        try {
          const { id: item } = itemParamsSchema.parse(req.params);
          const { tenantId } = req.auth!;
          await ensureTenantSettings(tenantId, deps.settingsRepo);
          // The membership guard makes a repeat skip / a stray un-skip match
          // no row, so only a write that changed something is audited.
          const { rowCount } = await db().query(
            method === 'put'
              ? `UPDATE tenant_settings
                    SET get_found_skipped_items = array_append(get_found_skipped_items, $2), updated_at = NOW()
                  WHERE tenant_id = $1 AND NOT ($2 = ANY (get_found_skipped_items))`
              : `UPDATE tenant_settings
                    SET get_found_skipped_items = array_remove(get_found_skipped_items, $2), updated_at = NOW()
                  WHERE tenant_id = $1 AND $2 = ANY (get_found_skipped_items)`,
            [tenantId, item],
          );
          if (rowCount) {
            const eventType = method === 'put' ? 'get_found.item.skipped' : 'get_found.item.unskipped';
            await auditAndRespond(req, res, eventType, { item });
          } else {
            res.json(deriveGetFoundChecklist(await loadGetFoundFacts(db(), tenantId)));
          }
        } catch (err) {
          const { statusCode, body } = toErrorResponse(err);
          res.status(statusCode).json(body);
        }
      },
    );
  }

  skipRoute('put');
  skipRoute('delete');

  return router;
}
