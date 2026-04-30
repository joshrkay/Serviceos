/**
 * Voice Sessions Router — P8-009
 *
 * HTTP + SSE endpoints for in-app voice sessions.
 *
 *   POST   /                → { sessionId }
 *   POST   /:id/input       → { state, ttsAudio?, proposalId? }
 *   GET    /:id/events      → SSE stream
 *   DELETE /:id             → 204
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import type { AuthenticatedRequest } from '../auth/clerk';
import type { InAppVoiceAdapter } from '../ai/agents/customer-calling/inapp-adapter';
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';

const startSessionSchema = z.object({
  conversationId: z.string().optional(),
});

const inputSchema = z.object({
  text: z.string().min(1, 'text is required'),
});

export interface VoiceSessionsRouterDeps {
  adapter: InAppVoiceAdapter;
  sessionStore: VoiceSessionStore;
}

export function createVoiceSessionsRouter(deps: VoiceSessionsRouterDeps): Router {
  const router = Router();

  // POST / — create a new voice session
  router.post(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const body = startSessionSchema.parse(req.body ?? {});
        const tenantId = req.auth!.tenantId;
        const userId = req.auth!.userId;
        const conversationId = body.conversationId ?? `conv-${Date.now()}`;

        const sessionId = await deps.adapter.startSession(tenantId, userId, conversationId);
        res.status(201).json({ sessionId });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  // POST /:id/input — send text input to an existing session
  router.post(
    '/:id/input',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const sessionId = req.params.id;
        const body = inputSchema.parse(req.body);

        const result = await deps.adapter.handleInput(sessionId, body.text);

        res.json({
          state: result.state,
          ttsAudio: result.ttsAudio
            ? result.ttsAudio.toString('base64')
            : undefined,
          proposalId: result.proposalId,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  // GET /:id/events — SSE stream for FSM state updates
  router.get(
    '/:id/events',
    requireAuth,
    requireTenant,
    (req: Request, res: Response) => {
      const sessionId = req.params.id;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Push function: write a single SSE data frame.
      const push = (payload: string) => {
        res.write(`data: ${payload}\n\n`);
      };

      // Register this client on the session via the shared sessionStore.
      const session = deps.sessionStore.get(sessionId);
      if (!session) {
        res.write(`data: ${JSON.stringify({ error: 'session_not_found' })}\n\n`);
        res.end();
        return;
      }

      session.sseClients.add(push);

      // Send the current state immediately so the client is never blank.
      push(
        JSON.stringify({
          state: session.machine.currentState,
          context: session.machine.currentContext,
        }),
      );

      // Remove this client when the connection is closed.
      req.on('close', () => {
        session.sseClients.delete(push);
      });
    },
  );

  // DELETE /:id — end the session
  router.delete(
    '/:id',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const sessionId = req.params.id;
        await deps.adapter.endSession(sessionId);
        res.status(204).send();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
