import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createConversationSchema, createMessageSchema } from '../shared/contracts';
import { createConversationWithAudit, ConversationRepository } from '../conversations/conversation-service';
import { AuditRepository } from '../audit/audit';

export function createConversationRouter(
  conversationRepo: ConversationRepository,
  auditRepo?: AuditRepository,
): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('conversations:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createConversationSchema.parse(req.body);
      const result = await createConversationWithAudit(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
        },
        conversationRepo,
        auditRepo,
        req.auth!.role,
      );
      res.status(201).json(result);
    })
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await conversationRepo.findById(req.auth!.tenantId, req.params.id);
      if (!result) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found' });
        return;
      }
      res.json(result);
    })
  );

  router.post(
    '/:id/messages',
    requireAuth,
    requireTenant,
    requirePermission('conversations:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
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
    })
  );

  router.get(
    '/:id/messages',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const result = await conversationRepo.getMessages(req.auth!.tenantId, req.params.id);
      res.json(result);
    })
  );

  return router;
}
