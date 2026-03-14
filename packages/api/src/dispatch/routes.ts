import { Router, Request, Response } from 'express';
import { getDispatchBoardData, BoardQueryDependencies } from './board-query';
import { AppointmentRepository } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';

export function createDispatchRoutes(deps: {
  appointmentRepo: AppointmentRepository;
  assignmentRepo: AssignmentRepository;
}): Router {
  const router = Router();

  router.get('/board', async (req: Request, res: Response) => {
    try {
      const tenantId = req.headers['x-tenant-id'] as string;
      if (!tenantId) {
        return res.status(400).json({ error: 'x-tenant-id header is required' });
      }

      const date = req.query.date as string;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD)' });
      }

      const timezone = req.query.timezone as string | undefined;

      const boardDeps: BoardQueryDependencies = {
        appointmentRepo: deps.appointmentRepo,
        assignmentRepo: deps.assignmentRepo,
      };

      const boardData = await getDispatchBoardData(tenantId, date, boardDeps, timezone);
      return res.json(boardData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
