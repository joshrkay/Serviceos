import { Router } from 'express';
import type { Request } from 'express';
import type { VoiceSessionEvent } from '../ai/agents/customer-calling/voice-session-store';

// Reuse the existing SSE-by-session pattern but per-user.
// Frontend hits /api/escalations/events; backend subscribes to all
// escalation_started events on the voice event bus FILTERED by the
// requesting user's userId AND tenantId (matched against dispatcherUserId
// and tenantId in the event) to prevent cross-tenant data leaks.

export interface EscalationEventsDeps {
  /** Extract the authenticated userId from the request (Clerk middleware). */
  authUserIdFromRequest: (req: Request) => Promise<string | null>;
  /** Extract the authenticated tenantId from the request (Clerk middleware). */
  authTenantIdFromRequest: (req: Request) => Promise<string | null>;
  /** Subscribe to all voice events across all active sessions. */
  subscribeToVoiceEvents: (callback: (evt: VoiceSessionEvent) => void) => () => void;
}

/**
 * GET /api/escalations/events
 *
 * Long-lived SSE stream. Emits `escalation_started` events to the
 * authenticated dispatcher whenever an AI agent escalates a call to them.
 * Filtered by dispatcherUserId AND tenantId so each dispatcher only receives
 * their own incoming transfers within their tenant. Includes a 25-second
 * heartbeat comment to keep connections alive through proxies/load balancers.
 */
export function escalationEventsRouter(deps: EscalationEventsDeps): Router {
  const router = Router();
  router.get('/events', async (req, res) => {
    // This raw async handler bypasses asyncRoute: a rejected auth lookup
    // would otherwise escape as an unhandledRejection and leave the
    // request hanging with no response.
    let userId: string | null;
    let tenantId: string | null;
    try {
      userId = await deps.authUserIdFromRequest(req);
      tenantId = await deps.authTenantIdFromRequest(req);
    } catch {
      res.status(500).end();
      return;
    }
    if (!userId || !tenantId) {
      res.status(401).end();
      return;
    }
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');
    res.flushHeaders();

    // Writes to a half-closed socket can throw synchronously. The
    // subscriber below runs inside EventEmitter.emit on session-store
    // timers, where an uncaught throw escapes to uncaughtException and
    // kills the process — never let a dead SSE client propagate.
    const safeWrite = (chunk: string): void => {
      try {
        res.write(chunk);
      } catch {
        // dead socket — the req 'close' handler detaches us
      }
    };

    const heartbeat = setInterval(() => {
      safeWrite(': hb\n\n');
    }, 25_000);
    if (typeof (heartbeat as unknown as { unref?: () => void }).unref === 'function') {
      (heartbeat as unknown as { unref: () => void }).unref();
    }

    const unsubscribe = deps.subscribeToVoiceEvents((evt) => {
      if (evt.type === 'escalation_started') {
        const startedEvt = evt as Extract<VoiceSessionEvent, { type: 'escalation_started' }>;
        if (startedEvt.dispatcherUserId === userId && startedEvt.tenantId === tenantId) {
          safeWrite(`data: ${JSON.stringify(startedEvt)}\n\n`);
        }
      }
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // already closed
      }
    });
  });
  return router;
}
