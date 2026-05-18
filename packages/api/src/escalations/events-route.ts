import { Router } from 'express';
import type { Request } from 'express';
import type { VoiceSessionEvent } from '../ai/agents/customer-calling/voice-session-store';

// Reuse the existing SSE-by-session pattern but per-user.
// Frontend hits /api/escalations/events; backend subscribes to all
// escalation_started events on the voice event bus FILTERED by the
// requesting user's userId (matched against dispatcherUserId in the event).

export interface EscalationEventsDeps {
  /** Extract the authenticated userId from the request (Clerk middleware). */
  authUserIdFromRequest: (req: Request) => Promise<string | null>;
  /** Subscribe to all voice events across all active sessions. */
  subscribeToVoiceEvents: (callback: (evt: VoiceSessionEvent) => void) => () => void;
}

/**
 * GET /api/escalations/events
 *
 * Long-lived SSE stream. Emits `escalation_started` events to the
 * authenticated dispatcher whenever an AI agent escalates a call to them.
 * Filtered by dispatcherUserId so each dispatcher only receives their own
 * incoming transfers.
 */
export function escalationEventsRouter(deps: EscalationEventsDeps): Router {
  const router = Router();
  router.get('/events', async (req, res) => {
    const userId = await deps.authUserIdFromRequest(req);
    if (!userId) {
      res.status(401).end();
      return;
    }
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');
    res.flushHeaders();

    const unsubscribe = deps.subscribeToVoiceEvents((evt) => {
      if (evt.type === 'escalation_started') {
        const startedEvt = evt as Extract<VoiceSessionEvent, { type: 'escalation_started' }>;
        if (startedEvt.dispatcherUserId === userId) {
          res.write(`data: ${JSON.stringify(startedEvt)}\n\n`);
        }
      }
    });

    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  });
  return router;
}
