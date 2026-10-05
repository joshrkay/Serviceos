/**
 * #1602 — production call-quality surface (owner-only).
 *
 *   GET  /api/voice/quality        7/30-day graded pass rates (windowed on
 *                                  when the CALL ended), the Layer 2 gate the
 *                                  SLO monitor alerts on, today's grading
 *                                  spend against the tenant's cap, and the
 *                                  last 10 graded calls with per-criterion
 *                                  pass/fail + the judge's rationale.
 *   POST /api/voice/quality/grade  on-demand trigger. `{}` ACCEPTS (202) and
 *                                  runs this tenant's sampling pass detached
 *                                  from the request — up to cap × judge calls
 *                                  of LLM latency must never sit inside the
 *                                  request transaction (the route is on the
 *                                  LLM-long-call bypass, and the pass runs
 *                                  outside the request's tenant context);
 *                                  409 while a pass is already running here.
 *                                  `{ sessionId }` grades one named call
 *                                  synchronously (200; re-grades if graded).
 *                                  Both audit `voice_quality.grade_requested`.
 *
 * Both routes demand `tenant:manage`, which only `owner` holds (auth/rbac.ts),
 * so they are owner-only by the executed-guard arm of I18 and carried in
 * docs/reference/owner-daily-actions.md.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/clerk';
import { type AuditRepository, createAuditEvent } from '../audit/audit';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { tenantContextStore } from '../middleware/tenant-context';
import type { VoiceSessionGrader } from '../voice/quality/grade-voice-session';
import type {
  VoiceQualityWindow,
  VoiceSessionGrade,
  VoiceSessionGradeStore,
} from '../voice/quality/voice-session-grade-store';
import type { VoiceQualityGradingWorker } from '../workers/voice-quality-grading-worker';

/** The Layer 2 launch gate (voice-quality harness): 85% of graded calls pass. */
export const VOICE_QUALITY_GATE_PASS_RATE_MIN = 0.85;

export const VOICE_QUALITY_GRADE_REQUESTED_EVENT = 'voice_quality.grade_requested';

interface RouteLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface VoiceQualityRouterDeps {
  store: VoiceSessionGradeStore;
  grader: VoiceSessionGrader;
  worker: VoiceQualityGradingWorker;
  /** Audit trail for the owner's trigger (all mutations emit audit events). */
  auditRepo?: Pick<AuditRepository, 'create'>;
  logger?: RouteLogger;
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
  const logger: RouteLogger = deps.logger ?? { warn: () => {}, error: () => {} };

  async function audit(
    req: AuthenticatedRequest,
    entity: { entityType: 'voice_quality_grading' | 'voice_session'; entityId: string },
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.auditRepo) return;
    try {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: req.auth!.tenantId,
          actorId: req.auth!.userId,
          actorRole: 'user',
          eventType: VOICE_QUALITY_GRADE_REQUESTED_EVENT,
          entityType: entity.entityType,
          entityId: entity.entityId,
          metadata,
        }),
      );
    } catch (err) {
      logger.warn('voice-quality: audit write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const at = now();
      // Sequential: under the request transaction all three reads share the
      // request's one pg client, which must not see concurrent queries.
      const summary = await deps.store.summary(tenantId, at);
      const quota = await deps.store.quota(tenantId);
      const gradedToday = await deps.store.countGradedSince(tenantId, startOfUtcDay(at));
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
        const sessionId = parsed.data.sessionId;
        await audit(req, { entityType: 'voice_session', entityId: sessionId }, {
          trigger: 'manual',
          scope: 'session',
          sessionId,
        });
        const result = await deps.grader.gradeVoiceSession(tenantId, sessionId, {
          trigger: 'manual',
          force: true,
        });
        if (result.status === 'skipped') {
          res
            .status(result.reason === 'not_found' ? 404 : 409)
            .json({ status: 'skipped', reason: result.reason });
          return;
        }
        res.json({ status: result.status, grade: gradeJson(result.grade) });
        return;
      }

      if (deps.worker.isRunning(tenantId)) {
        res.status(409).json({ accepted: false, alreadyRunning: true });
        return;
      }
      await audit(req, { entityType: 'voice_quality_grading', entityId: tenantId }, {
        trigger: 'manual',
        scope: 'sample',
      });
      // Detached, and OUTSIDE the request's tenant context: the pass must not
      // inherit the request-scoped pg client, which is released when this
      // response ends. Each store call then opens its own short transaction.
      void tenantContextStore.exit(() =>
        deps.worker
          .handle({ tenantId, trigger: 'manual' })
          .catch((err: unknown) => {
            logger.error('voice-quality: manual grading pass failed', {
              tenantId,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
      );
      res.status(202).json({ accepted: true });
    }),
  );

  return router;
}
