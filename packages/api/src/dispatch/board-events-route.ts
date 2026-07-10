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

    const date = req.query.date as string;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD)' });
      return;
    }

    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');
    res.flushHeaders();

    // Writes to a half-closed socket can throw synchronously; the bus
    // subscriber runs on the publisher's stack, so a dead SSE client
    // must never propagate a throw out of this handler.
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
    if (typeof (heartbeat as NodeJS.Timeout).unref === 'function') {
      heartbeat.unref();
    }

    const bus = getDispatchBoardEventBus();
    const unsubscribe = bus.subscribe(tenantId, date, (evt) => {
      safeWrite(`data: ${JSON.stringify(evt)}\n\n`);
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
