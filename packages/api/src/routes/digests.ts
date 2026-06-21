/**
 * RV-062 (F-9) — End-of-Day Digest web view backend.
 *
 * GET /api/digests/:date → the stored daily_digests row (payload +
 * narrative + generatedAt) for the authenticated tenant. `:date` is a
 * tenant-local YYYY-MM-DD, or the literal `latest` for the most recent
 * digest (the SMS deep link's default landing). 404 when none exists.
 *
 * Read-only: this router never recomputes — it serves the snapshot the
 * digest worker already stored. Tenant scoping is handled by the repo's
 * explicit tenant_id predicates (per house style).
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import type { DailyDigestRepository } from '../digest/digest-service';

export interface DigestsRouterDeps {
  digestRepo: DailyDigestRepository;
}

/** YYYY-MM-DD, calendar-valid (e.g. 2026-13-99 is rejected). */
const dateParamSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD or "latest"')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s;
  }, 'date must be YYYY-MM-DD or "latest"');

export function createDigestsRouter(deps: DigestsRouterDeps): Router {
  const router = Router();

  router.get(
    '/:date',
    requireAuth,
    requireTenant,
    requirePermission('reports:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const raw = req.params.date;

      const record =
        raw === 'latest'
          ? await deps.digestRepo.findLatest(tenantId)
          : await (async () => {
              const parsed = dateParamSchema.safeParse(raw);
              if (!parsed.success) return undefined;
              return deps.digestRepo.findByTenantAndDate(tenantId, parsed.data);
            })();

      if (record === undefined) {
        res
          .status(400)
          .json({ error: 'VALIDATION_ERROR', message: 'date must be YYYY-MM-DD or "latest"' });
        return;
      }
      if (record === null) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'No digest for this day' });
        return;
      }

      res.json({
        data: {
          date: record.digestDate,
          payload: record.payload,
          narrative: record.narrative ?? null,
          generatedAt: record.generatedAt.toISOString(),
        },
      });
    }),
  );

  return router;
}
