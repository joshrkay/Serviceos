/**
 * P2-030 — Evaluation admin read API.
 *
 * GET /api/evaluation/shadow-comparisons
 *   - Owner-only (ai:configure permission).
 *   - Tenant-scoped via RLS + explicit WHERE tenant_id.
 *   - Cursor-based pagination (ISO timestamp cursor).
 */

import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import type { AuthenticatedRequest } from '../auth/clerk';
import type { ShadowComparisonStore } from '../ai/evaluation/shadow-comparison';

export interface EvaluationRouterDeps {
  shadowStore: ShadowComparisonStore;
}

export function createEvaluationRouter(deps: EvaluationRouterDeps): Router {
  const router = Router();

  /**
   * GET /api/evaluation/shadow-comparisons
   *
   * Query params:
   *   - taskType   (optional) — filter by AI run task type
   *   - limit      (optional, default 50, max 200)
   *   - cursor     (optional) — opaque pagination cursor (ISO timestamp)
   */
  router.get(
    '/shadow-comparisons',
    requireAuth,
    requireTenant,
    requirePermission('ai:configure'),
    asyncRoute(async (req: AuthenticatedRequest, res) => {
      const tenantId = req.auth!.tenantId;

      const taskType =
        typeof req.query.taskType === 'string' ? req.query.taskType : undefined;
      const rawLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
      const cursor =
        typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

      if (cursor !== undefined) {
        const ts = Date.parse(cursor);
        if (!Number.isFinite(ts)) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid cursor' });
          return;
        }
      }

      const page = await deps.shadowStore.listForTenant(tenantId, {
        taskType,
        limit,
        cursor,
      });

      const comparisons = page.comparisons.map((c) => ({
        id: c.id,
        aiRunId: c.aiRunId ?? null,
        taskType: c.taskType ?? null,
        shadowModel: c.shadowResponse?.model ?? c.primaryResponse.model,
        primaryResponseText: c.primaryResponse.content,
        shadowResponseText: c.shadowResponse?.content ?? null,
        primaryLatencyMs: c.primaryResponse.latencyMs,
        shadowLatencyMs: c.shadowResponse?.latencyMs ?? null,
        primaryTokenUsage: c.primaryResponse.tokenUsage,
        shadowTokenUsage: c.shadowResponse?.tokenUsage ?? null,
        divergenceScore: c.divergenceScore ?? null,
        createdAt: c.sampledAt.toISOString(),
      }));

      res.json({ comparisons, nextCursor: page.nextCursor });
    })
  );

  return router;
}
