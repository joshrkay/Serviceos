import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createNoteSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
import { createNote, updateNote, deleteNote, listNotes, NoteRepository } from '../notes/note';

export function createNoteRouter(noteRepo: NoteRepository): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('notes:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createNoteSchema.parse(req.body);
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
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('notes:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
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
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('notes:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
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
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.delete(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('notes:delete'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const deleted = await deleteNote(req.auth!.tenantId, req.params.id, noteRepo);
        if (!deleted) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Note not found' });
          return;
        }
        res.status(204).send();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
