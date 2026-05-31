import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createConversationSchema, createMessageSchema } from '../shared/contracts';
import { createConversationWithAudit, ConversationRepository } from '../conversations/conversation-service';
import { AuditRepository } from '../audit/audit';
import { LLMGateway } from '../ai/gateway/gateway';
import { SettingsRepository } from '../settings/settings';
import { SuggestReplyTask } from '../ai/tasks/suggest-reply-task';

export interface ConversationRouterAiDeps {
  /** When present, enables POST /:id/suggest-reply (AI draft replies). */
  gateway?: LLMGateway;
  settingsRepo?: SettingsRepository;
}

export function createConversationRouter(
  conversationRepo: ConversationRepository,
  auditRepo?: AuditRepository,
  aiDeps?: ConversationRouterAiDeps,
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

  // POST /:id/suggest-reply — AI-drafted reply for the owner to edit and send.
  // Draft only: nothing is sent and no proposal is created. Requires the AI
  // gateway to be wired; otherwise returns 503 so the UI can hide the action.
  router.post(
    '/:id/suggest-reply',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      if (!aiDeps?.gateway) {
        res.status(503).json({ error: 'UNAVAILABLE', message: 'AI suggestions are not configured' });
        return;
      }
      const tenantId = req.auth!.tenantId;
      const conversation = await conversationRepo.findById(tenantId, req.params.id);
      if (!conversation) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Conversation not found' });
        return;
      }

      const messages = await conversationRepo.getMessages(tenantId, req.params.id);
      const settings = await aiDeps.settingsRepo?.findByTenant(tenantId);

      const task = new SuggestReplyTask(aiDeps.gateway);
      const { draft } = await task.suggest({
        messages: messages
          .filter((m) => m.messageType === 'text' || m.messageType === 'transcript')
          .map((m) => ({ senderRole: m.senderRole, content: m.content ?? '' })),
        brandVoice: settings?.brandVoice,
        businessName: settings?.businessName,
      });

      res.status(200).json({ draft });
    })
  );

  return router;
}
