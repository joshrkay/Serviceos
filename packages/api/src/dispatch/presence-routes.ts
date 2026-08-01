import { Router, Response } from 'express';
import { requireAuth, requireTenant } from '../middleware/auth';
import { AuthenticatedRequest } from '../auth/clerk';
import {
  upsertDispatchPresence,
  clearDispatchPresence,
} from './presence-store';
import { getDispatchBoardEventBus } from './board-event-bus';

/**
 * HTTP presence heartbeat — the fallback transport for clients whose WS
 * gateway connection is down (UC-3 moved the primary heartbeat onto the
 * client-gateway WebSocket). Fallback clients poll at ≥30s and send a `ttlMs`
 * that outlives their poll; legacy clients on the original 5s PUT send no
 * `ttlMs` and get the unchanged 15s default.
 */
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 120_000;

function ttlMsFromBody(body: unknown): number | undefined {
  const raw = (body as { ttlMs?: unknown } | undefined)?.ttlMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return Math.min(Math.max(Math.floor(raw), MIN_TTL_MS), MAX_TTL_MS);
}

export function createPresenceRouter(): Router {
  const router = Router();

  router.put(
    '/presence',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const userId = req.auth!.userId;
      const displayName =
        (typeof req.body?.displayName === 'string' && req.body.displayName) ||
        req.clerkUser?.firstName ||
        req.clerkUser?.email ||
        userId;

      const date = req.body?.date as string | undefined;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
      }

      const mode = req.body?.mode === 'dragging' ? 'dragging' : 'viewing';
      const appointmentId =
        typeof req.body?.appointmentId === 'string' ? req.body.appointmentId : null;
      const ttlMs = ttlMsFromBody(req.body);

      const changed = await upsertDispatchPresence({
        tenantId,
        date,
        userId,
        displayName,
        appointmentId,
        mode,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      });

      // Publish only when the VISIBLE state changed — a steady-state heartbeat
      // (pure TTL refresh) must not fan out into a board refetch per viewer.
      if (changed) getDispatchBoardEventBus().publishPresenceUpdated(tenantId, date);
      return res.status(204).end();
    },
  );

  router.delete(
    '/presence',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const userId = req.auth!.userId;
      const date = (req.query.date as string) || (req.body?.date as string);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
      }
      const changed = await clearDispatchPresence(tenantId, date, userId);
      if (changed) getDispatchBoardEventBus().publishPresenceUpdated(tenantId, date);
      return res.status(204).end();
    },
  );

  return router;
}
