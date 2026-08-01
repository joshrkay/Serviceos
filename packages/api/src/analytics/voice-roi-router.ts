import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { DEFAULT_VOICE_ROI_WINDOW_DAYS, type VoiceRoiReporter } from './voice-roi';

/**
 * Epic 12.5 — GET /api/analytics/voice-roi
 *
 * Owner-facing voice ROI headline (inbound / answered / booked / after-hours /
 * would-have-hit-voicemail) over a rolling window. Reuses `invoices:view`
 * (the same owner-report permission as /api/reports/hfcr et al). 503s when the
 * reporter is not wired.
 */
export interface VoiceRoiRouterDeps {
  voiceRoiReporter?: VoiceRoiReporter;
}

const MAX_WINDOW_DAYS = 365;

export function createVoiceRoiRouter(deps: VoiceRoiRouterDeps): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('invoices:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.voiceRoiReporter) {
          res.status(503).json({ error: 'NOT_CONFIGURED', message: 'Voice ROI unavailable' });
          return;
        }
        let days = DEFAULT_VOICE_ROI_WINDOW_DAYS;
        const daysRaw = req.query.days as string | undefined;
        if (daysRaw !== undefined) {
          const parsed = Number(daysRaw);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_WINDOW_DAYS) {
            res.status(400).json({
              error: 'VALIDATION_ERROR',
              message: `\`days\` must be an integer in [1, ${MAX_WINDOW_DAYS}]`,
            });
            return;
          }
          days = parsed;
        }
        const summary = await deps.voiceRoiReporter.query(req.auth!.tenantId, new Date(), { days });
        res.json({ data: summary });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
