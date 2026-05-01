/**
 * /api/voice/sessions — in-app voice session HTTP surface (P8-009).
 *
 * Three POST endpoints + an SSE endpoint for FSM transition pushes:
 *
 *   POST   /                    → InAppVoiceAdapter.startSession()
 *   POST   /:id/input           → InAppVoiceAdapter.handleInput(text)
 *   GET    /:id/events          → SSE stream of {state,event,context}
 *   DELETE /:id                 → InAppVoiceAdapter.endSession()
 *
 * Tenant isolation: every route reads tenantId from req.auth and 404s
 * when the requested session belongs to a different tenant. This is
 * the same pattern used by the conversations / proposals routers.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { InAppVoiceAdapter } from '../ai/agents/customer-calling/inapp-adapter';
import type { VoiceSessionStore, VoiceSessionEvent } from '../ai/agents/customer-calling/voice-session-store';

export interface VoiceSessionsRouterDeps {
  adapter: InAppVoiceAdapter;
  store: VoiceSessionStore;
}

const startSchema = z.object({
  conversationId: z.string().min(1).optional(),
});

const inputSchema = z.object({
  text: z.string().min(1).max(2000),
});

export function createVoiceSessionsRouter(deps: VoiceSessionsRouterDeps): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = startSchema.parse(req.body ?? {});
        const result = await deps.adapter.startSession(
          req.auth!.tenantId,
          req.auth!.userId,
          parsed.conversationId
        );
        res.status(201).json({
          sessionId: result.sessionId,
          state: result.state,
          greetingText: result.greetingText,
          greetingAudio: result.greetingAudio
            ? result.greetingAudio.toString('base64')
            : undefined,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/input',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const session = deps.store.peek(req.params.id);
        if (!session || session.tenantId !== req.auth!.tenantId) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Voice session not found' });
          return;
        }
        if (session.ended) {
          // 410 Gone is the right status here — the resource existed but
          // is permanently terminated. Lets the frontend stop polling
          // without confusing it with a 404.
          res.status(410).json({ error: 'GONE', message: 'Session ended' });
          return;
        }
        const parsed = inputSchema.parse(req.body ?? {});
        const result = await deps.adapter.handleInput(req.params.id, parsed.text);
        res.json({
          state: result.state,
          sideEffects: result.sideEffects,
          ttsText: result.ttsText,
          ttsAudio: result.ttsAudio ? result.ttsAudio.toString('base64') : undefined,
          proposalIds: result.proposalIds,
          ended: result.ended,
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/:id/events',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    (req: AuthenticatedRequest, res: Response) => {
      const session = deps.store.peek(req.params.id);
      if (!session || session.tenantId !== req.auth!.tenantId) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Voice session not found' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      // Send the current state immediately so the client renders
      // something even if no transition has fired yet.
      res.write(
        `data: ${JSON.stringify({ type: 'snapshot', state: session.machine.currentState })}\n\n`
      );

      const onEvent = (event: VoiceSessionEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'ended') {
          res.end();
        }
      };
      session.events.on('voice-event', onEvent);

      // Heartbeat keeps proxies / Cloudflare from killing the stream
      // during long idle stretches. Unrefed so it doesn't block exit.
      const heartbeat = setInterval(() => {
        res.write(': hb\n\n');
      }, 25000);
      heartbeat.unref?.();

      req.on('close', () => {
        session.events.off('voice-event', onEvent);
        clearInterval(heartbeat);
      });
    }
  );

  router.delete(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const session = deps.store.peek(req.params.id);
        if (!session || session.tenantId !== req.auth!.tenantId) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Voice session not found' });
          return;
        }
        await deps.adapter.endSession(req.params.id);
        res.status(204).end();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
