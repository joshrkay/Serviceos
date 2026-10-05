/**
 * #1602 — production call-quality surface (owner-only).
 *
 *   GET  /api/voice/quality        7/30-day graded pass rates (windowed on
 *                                  when the CALL ended), the Layer 2 gate the
 *                                  SLO monitor alerts on, today's grading
 *                                  spend against the tenant's cap, and the
 *                                  last 10 graded calls with per-criterion
 *                                  pass/fail + the judge's rationale.
 *   POST /api/voice/quality/grade  on-demand trigger: `{}` runs this tenant
 *                                  through the sampling pass now (202, same
 *                                  daily cap as the nightly run);
 *                                  `{ sessionId }` grades one named call
 *                                  (200, re-grades if already graded).
 *
 * Both routes demand `tenant:manage`, which only `owner` holds (auth/rbac.ts),
 * so they are owner-only by the executed-guard arm of I18 and carried in
 * docs/reference/owner-daily-actions.md.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import type { VoiceSessionGrader } from '../voice/quality/grade-voice-session';
import type {
  VoiceQualityWindow,
  VoiceSessionGrade,
  VoiceSessionGradeStore,
} from '../voice/quality/voice-session-grade-store';
import type { VoiceQualityGradingWorker } from '../workers/voice-quality-grading-worker';

/** The Layer 2 launch gate (voice-quality harness): 85% of graded calls pass. */
export const VOICE_QUALITY_GATE_PASS_RATE_MIN = 0.85;

export interface VoiceQualityRouterDeps {
  store: VoiceSessionGradeStore;
  grader: VoiceSessionGrader;
  worker: VoiceQualityGradingWorker;
  /** Defaults to the Layer 2 gate; app.ts passes the SLO threshold so the two agree. */
  passRateMin?: number;
  now?: () => Date;
}

const gradeBodySchema = z.object({
  sessionId: z.guid().optional(),
});

function windowJson(w: VoiceQualityWindow): VoiceQualityWindow & { passRate: number | null } {
  return { ...w, passRate: w.graded === 0 ? null : w.passed / w.graded };
}

function gradeJson(g: VoiceSessionGrade) {
  return {
    sessionId: g.sessionId,
    gradedAt: g.gradedAt.toISOString(),
    passed: g.passed,
    criteria: g.criteria,
    rubricVersion: g.rubricVersion,
    model: g.model,
    judgeCalls: g.judgeCalls,
    costMicroCents: g.costMicroCents,
    trigger: g.trigger,
    callEndedAt: g.callEndedAt.toISOString(),
    outcome: g.outcome,
  };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function createVoiceQualityRouter(deps: VoiceQualityRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const passRateMin = deps.passRateMin ?? VOICE_QUALITY_GATE_PASS_RATE_MIN;

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const at = now();
      const [summary, quota, gradedToday] = await Promise.all([
        deps.store.summary(tenantId, at),
        deps.store.quota(tenantId),
        deps.store.countGradedSince(tenantId, startOfUtcDay(at)),
      ]);
      res.json({
        windows: { last7d: windowJson(summary.last7d), last30d: windowJson(summary.last30d) },
        gate: { passRateMin },
        quota: { ...quota, gradedToday },
        recent: summary.recent.map(gradeJson),
      });
    }),
  );

  router.post(
    '/grade',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = gradeBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sessionId must be a UUID' });
        return;
      }
      const tenantId = req.auth!.tenantId;
      if (parsed.data.sessionId) {
        const result = await deps.grader.gradeVoiceSession(tenantId, parsed.data.sessionId, {
          trigger: 'manual',
          force: true,
        });
        if (result.status === 'skipped') {
          res.status(result.reason === 'not_found' ? 404 : 409).json({ status: 'skipped', reason: result.reason });
          return;
        }
        res.json({ status: result.status, grade: gradeJson(result.grade) });
        return;
      }
      const run = await deps.worker.handle({ tenantId, trigger: 'manual' });
      res.status(202).json(run);
    }),
  );

  return router;
}
