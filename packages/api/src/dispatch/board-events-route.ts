import { Router, Response } from 'express';
import type { Request } from 'express';
import { getDispatchBoardEventBus } from './board-event-bus';

export interface BoardEventsRouteDeps {
  authUserIdFromRequest: (req: Request) => Promise<string | null>;
  authTenantIdFromRequest: (req: Request) => Promise<string | null>;
}

export function createBoardEventsRouter(deps: BoardEventsRouteDeps): Router {
  const router = Router();

  router.get('/board/events', async (req, res: Response) => {
    const userId = await deps.authUserIdFromRequest(req);
    const tenantId = await deps.authTenantIdFromRequest(req);
    if (!userId || !tenantId) {
      res.status(401).end();
      return;
    }

    const date = req.query.date as string;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD)' });
      return;
    }

    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
      res.write(': hb\n\n');
    }, 25_000);
    if (typeof (heartbeat as NodeJS.Timeout).unref === 'function') {
      heartbeat.unref();
    }

    const bus = getDispatchBoardEventBus();
    const unsubscribe = bus.subscribe(tenantId, date, (evt) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  return router;
}
