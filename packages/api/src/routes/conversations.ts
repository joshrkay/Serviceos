import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createConversationSchema, createMessageSchema } from '../shared/contracts';
import { toErrorResponse } from '../shared/errors';
import { ConversationRepository } from '../conversations/conversation-service';

export function createConversationRouter(conversationRepo: ConversationRepository): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('conversations:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createConversationSchema.parse(req.body);
        const result = await conversationRepo.createConversation({
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
        });
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await conversationRepo.findById(req.auth!.tenantId, req.params.id);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/:id/messages',
    requireAuth,
    requireTenant,
    requirePermission('conversations:create'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = createMessageSchema.parse({
          ...req.body,
          conversationId: req.params.id,
        });
        const result = await conversationRepo.addMessage({
          ...parsed,
          tenantId: req.auth!.tenantId,
          senderId: req.auth!.userId,
          senderRole: req.auth!.role,
        });
        res.status(201).json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/:id/messages',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await conversationRepo.getMessages(req.auth!.tenantId, req.params.id);
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
