import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createNoteSchema } from '../shared/contracts';
import { OwnedEntityType, TenantOwnership } from '../shared/tenant-ownership';
import { createNote, updateNote, deleteNote, listNotes, NoteRepository } from '../notes/note';

export function createNoteRouter(
  noteRepo: NoteRepository,
  ownership: TenantOwnership
): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('notes:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createNoteSchema.parse(req.body);
      await ownership.requireExists(
        req.auth!.tenantId,
        parsed.entityType as OwnedEntityType,
        parsed.entityId
      );
      const result = await createNote(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          authorId: req.auth!.userId,
          authorRole: req.auth!.role,
        },
        noteRepo
      );
      res.status(201).json(result);
    })
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('notes:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const entityType = req.query.entityType as string;
      const entityId = req.query.entityId as string;
      if (!entityType || !entityId) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'entityType and entityId query parameters are required',
        });
        return;
      }
      const result = await listNotes(req.auth!.tenantId, entityType as any, entityId, noteRepo);
      res.json(result);
    })
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('notes:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const { content } = req.body;
      if (!content) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'content is required' });
        return;
      }
      const result = await updateNote(req.auth!.tenantId, req.params.id, content, noteRepo);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Note not found' });
        return;
      }
      res.json(result);
    })
  );

  router.delete(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('notes:delete'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const deleted = await deleteNote(req.auth!.tenantId, req.params.id, noteRepo);
      if (!deleted) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Note not found' });
        return;
      }
      res.status(204).send();
    })
  );

  return router;
}
