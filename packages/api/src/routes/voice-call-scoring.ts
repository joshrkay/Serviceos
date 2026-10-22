/**
 * #1736 — owner-facing review of scored calls (owner-only).
 *
 *   GET  /api/voice/scoring                 the scoring switch + the most recent
 *                                           scored calls (0-100 score, per-item
 *                                           verdicts, flagged moments, and the
 *                                           owner's correction if any).
 *                                           `?flagged=1` keeps only calls that
 *                                           need a look (a failed item or a
 *                                           non-strength flag).
 *   PUT  /api/voice/scoring/settings        `{ enabled }` — the per-tenant
 *                                           opt-in. Scoring is OFF by default;
 *                                           audit `voice_call_scoring.setting_changed`.
 *   POST /api/voice/scoring/:sessionId/correct
 *                                           "correct this call": `{ kind,
 *                                           turnIndex?, note? }`. One correction
 *                                           per call (a second replaces it). It
 *                                           is queued for export into the
 *                                           voice-quality corpus as a regression
 *                                           case; audit `voice_call.corrected`.
 *
 * All three demand `tenant:manage`, which only `owner` holds (auth/rbac.ts).
 */
import { randomUUID } from 'crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/clerk';
import { type AuditRepository, createAuditEvent } from '../audit/audit';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { pairTranscriptTurns } from '../voice/quality/transcript-observation';
import type { VoiceSessionGradeStore } from '../voice/quality/voice-session-grade-store';
import { needsReview, type CallScore } from '../voice/scoring/call-score';
import {
  CORRECTION_KINDS,
  type CallCorrection,
  type CallScoreStore,
} from '../voice/scoring/call-score-store';

export const SCORING_SETTING_CHANGED_EVENT = 'voice_call_scoring.setting_changed';
export const CALL_CORRECTED_EVENT = 'voice_call.corrected';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

export interface VoiceCallScoringRouterDeps {
  store: CallScoreStore;
  /** #1602's seam — only `loadSession` (to validate the corrected turn). */
  sessions: Pick<VoiceSessionGradeStore, 'loadSession'>;
  auditRepo?: Pick<AuditRepository, 'create'>;
}

const settingsBody = z.object({ enabled: z.boolean() });
const correctBody = z.object({
  kind: z.enum(CORRECTION_KINDS),
  turnIndex: z.number().int().min(0).optional(),
  note: z.string().trim().max(500).optional(),
});
const listQuery = z.object({
  flagged: z.enum(['1', 'true']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
});

function correctionJson(c: CallCorrection | undefined) {
  return c
    ? {
        kind: c.kind,
        turnIndex: c.turnIndex,
        note: c.note,
        createdAt: c.createdAt.toISOString(),
        exported: c.exportedAt !== null,
      }
    : null;
}

function scoreJson(s: CallScore, correction: CallCorrection | undefined) {
  return {
    sessionId: s.sessionId,
    score: s.score,
    scoredAt: s.scoredAt.toISOString(),
    callEndedAt: s.callEndedAt.toISOString(),
    rubricVersion: s.rubricVersion,
    summary: s.summary,
    items: s.items,
    flags: s.flags,
    needsReview: needsReview(s),
    correction: correctionJson(correction),
  };
}

export function createVoiceCallScoringRouter(deps: VoiceCallScoringRouterDeps): Router {
  const router = Router();

  async function audit(
    req: AuthenticatedRequest,
    eventType: string,
    entityType: 'tenant_settings' | 'voice_session',
    entityId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.auditRepo) return;
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: req.auth!.tenantId,
        actorId: req.auth!.userId,
        actorRole: 'user',
        eventType,
        entityType,
        entityId,
        metadata,
      }),
    );
  }

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const query = listQuery.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'invalid query' });
        return;
      }
      const tenantId = req.auth!.tenantId;
      // Sequential: under the request transaction the reads share one pg client.
      const enabled = await deps.store.isEnabled(tenantId);
      const scores = await deps.store.listScores(tenantId, query.data.limit ?? DEFAULT_LIST_LIMIT);
      const corrections = await deps.store.listCorrectionsForSessions(
        tenantId,
        scores.map((s) => s.sessionId),
      );
      const bySession = new Map(corrections.map((c) => [c.sessionId, c] as const));
      const rows = scores
        .filter((s) => !query.data.flagged || needsReview(s))
        .map((s) => scoreJson(s, bySession.get(s.sessionId)));
      res.json({ enabled, calls: rows });
    }),
  );

  router.put(
    '/settings',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const body = settingsBody.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'enabled must be a boolean' });
        return;
      }
      const tenantId = req.auth!.tenantId;
      await deps.store.setEnabled(tenantId, body.data.enabled);
      await audit(req, SCORING_SETTING_CHANGED_EVENT, 'tenant_settings', tenantId, {
        enabled: body.data.enabled,
      });
      res.json({ enabled: body.data.enabled });
    }),
  );

  router.post(
    '/:sessionId/correct',
    requireAuth,
    requireTenant,
    requirePermission('tenant:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const sessionId = z.guid().safeParse(req.params.sessionId);
      const body = correctBody.safeParse(req.body ?? {});
      if (!sessionId.success || !body.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'invalid correction' });
        return;
      }
      const tenantId = req.auth!.tenantId;
      const score = await deps.store.findScore(tenantId, sessionId.data);
      if (!score) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'No scored call with that id' });
        return;
      }
      if (body.data.turnIndex !== undefined) {
        const session = await deps.sessions.loadSession(tenantId, sessionId.data);
        const turns = session ? pairTranscriptTurns(session.transcript).length : 0;
        if (body.data.turnIndex >= turns) {
          res.status(400).json({ error: 'VALIDATION_ERROR', message: 'turnIndex is past the end of the call' });
          return;
        }
      }
      const saved = await deps.store.saveCorrection({
        id: randomUUID(),
        tenantId,
        sessionId: sessionId.data,
        kind: body.data.kind,
        turnIndex: body.data.turnIndex ?? null,
        note: body.data.note ?? '',
        createdBy: req.auth!.userId,
        createdAt: new Date(),
        exportedAt: null,
        corpusScriptId: null,
      });
      await audit(req, CALL_CORRECTED_EVENT, 'voice_session', sessionId.data, {
        correctionId: saved.id,
        kind: saved.kind,
        turnIndex: saved.turnIndex,
      });
      res.status(201).json({ correction: correctionJson(saved) });
    }),
  );

  return router;
}
