import { Router, Response } from 'express';
import { requireAuth, requireTenant } from '../middleware/auth';
import { AuthenticatedRequest } from '../auth/clerk';
import {
  upsertDispatchPresence,
  clearDispatchPresence,
} from './presence-store';
import { getDispatchBoardEventBus } from './board-event-bus';

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

      upsertDispatchPresence({
        tenantId,
        date,
        userId,
        displayName,
        appointmentId,
        mode,
      });

      getDispatchBoardEventBus().publishPresenceUpdated(tenantId, date);
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
      clearDispatchPresence(tenantId, date, userId);
      getDispatchBoardEventBus().publishPresenceUpdated(tenantId, date);
      return res.status(204).end();
    },
  );

  return router;
}
