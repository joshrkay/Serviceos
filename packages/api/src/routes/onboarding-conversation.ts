/**
 * POST /api/onboarding/conversation/turn — drive one turn of the
 * Onboarding Agent's conversational FSM.
 *
 * Wraps `OnboardingConversationOrchestrator` from
 * `src/ai/orchestration/onboarding-conversation.ts`. Auth + tenant
 * guards are the standard middleware stack (requireAuth + requireTenant
 * + requireRole 'owner'); the role gate matches POST /api/onboarding/pack
 * since the FSM emits config-change proposals against the tenant's
 * settings + catalog.
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import { OnboardingConversationOrchestrator } from '../ai/orchestration/onboarding-conversation';

const TurnRequestSchema = z.object({
  /** Omit to start a new session. The first turn with no sessionId and
   *  no userMessage surfaces the opening prompt without consuming a turn. */
  sessionId: z.string().uuid().optional(),
  /** User utterance. Required after the opening prompt; optional on the
   *  very first call so the UI can render the assistant's greeting. */
  userMessage: z.string().min(1).max(2000).optional(),
});

export interface OnboardingConversationRouterDeps {
  orchestrator: OnboardingConversationOrchestrator;
}

export function createOnboardingConversationRouter(
  deps: OnboardingConversationRouterDeps,
): Router {
  const router = Router();

  router.post(
    '/turn',
    requireAuth,
    requireTenant,
    requireRole('owner'),
    async (req: AuthenticatedRequest, res: Response) => {
      const parsed = TurnRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', issues: parsed.error.issues });
        return;
      }

      try {
        const result = await deps.orchestrator.turn({
          tenantId: req.auth!.tenantId,
          userId: req.auth!.userId,
          sessionId: parsed.data.sessionId,
          userMessage: parsed.data.userMessage,
        });
        res.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'ONBOARDING_SESSION_NOT_FOUND') {
          res.status(404).json({
            error: 'ONBOARDING_SESSION_NOT_FOUND',
            message: 'Session does not exist for this tenant',
          });
          return;
        }
        res.status(500).json({
          error: 'ONBOARDING_CONVERSATION_FAILED',
          message,
        });
      }
    },
  );

  return router;
}
