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
import { asyncRoute } from '../middleware/async-route';
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

  // X10/PR#398 — supervisor-wall discovery. The WS gateway rejects
  // voice subscriptions without a targetId (see authorizeSubscribe),
  // so the wall first fetches the list of active sessions for the
  // tenant, seeds its local state, and then sends one `subscribe`
  // frame per session id. Channel value is mapped to the wall's
  // SessionChannel enum so the frontend doesn't have to do it.
  router.get(
    '/active',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    (req: AuthenticatedRequest, res: Response) => {
      const sessions = deps.store.listActiveByTenant(req.auth!.tenantId).map((s) => ({
        id: s.id,
        channel: s.channel === 'telephony' ? 'voice_inbound' : 'inapp_voice',
        startedAt: s.createdAt.toISOString(),
      }));
      res.json({ sessions });
    },
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = startSchema.parse(req.body ?? {});
      const result = await deps.adapter.startSession(
        req.auth!.tenantId,
        req.auth!.userId,
        parsed.conversationId,
        req.auth!.role,
      );
      res.status(201).json({
        sessionId: result.sessionId,
        state: result.state,
        greetingText: result.greetingText,
        greetingAudio: result.greetingAudio
          ? result.greetingAudio.toString('base64')
          : undefined,
      });
    })
  );

  router.post(
    '/:id/input',
    requireAuth,
    requireTenant,
    requirePermission('ai:run'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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
    })
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

      // A half-closed socket can make res.write()/res.end() throw
      // synchronously. onEvent runs inside EventEmitter.emit from store
      // timers (e.g. reapIdle), where an uncaught throw escapes to
      // uncaughtException and kills the whole process — a dead SSE
      // client must never propagate past this handler.
      const safeWrite = (chunk: string): void => {
        try {
          res.write(chunk);
        } catch {
          // dead socket — the req 'close' handler detaches us
        }
      };

      // Send the current state immediately so the client renders
      // something even if no transition has fired yet.
      safeWrite(
        `data: ${JSON.stringify({ type: 'snapshot', state: session.machine.currentState })}\n\n`
      );

      const onEvent = (event: VoiceSessionEvent) => {
        safeWrite(`data: ${JSON.stringify(event)}\n\n`);
        // Mirror SSE events onto the client WS gateway. publish() is a
        // no-op when the gateway is disabled, so SSE remains the source
        // of truth during ramp.
        void import('../ws/client-gateway')
          .then(({ publish }) => {
            publish(
              'voice',
              session.id,
              {
                kind: 'voice.event',
                channel: 'voice',
                sessionId: session.id,
                event: event.type,
                state: 'state' in event ? (event as { state?: string }).state : undefined,
                payload: event as unknown as Record<string, unknown>,
              },
              session.tenantId,
            );
          })
          .catch((err) => {
            process.stderr.write(
              `voice SSE→WS mirror failed: ${err instanceof Error ? err.message : String(err)}\n`
            );
          });
        if (event.type === 'ended') {
          try {
            res.end();
          } catch {
            // already closed
          }
        }
      };
      session.events.on('voice-event', onEvent);

      // Heartbeat keeps proxies / Cloudflare from killing the stream
      // during long idle stretches. Unrefed so it doesn't block exit.
      const heartbeat = setInterval(() => {
        safeWrite(': hb\n\n');
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
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const session = deps.store.peek(req.params.id);
      if (!session || session.tenantId !== req.auth!.tenantId) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Voice session not found' });
        return;
      }
      await deps.adapter.endSession(req.params.id);
      res.status(204).end();
    })
  );

  return router;
}
