import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { createConversationSchema, createMessageSchema } from '../shared/contracts';
import {
  createConversationWithAudit,
  getOrCreateCustomerConversation,
  ConversationRepository,
} from '../conversations/conversation-service';
import {
  sendConversationReply,
  ConversationReplyError,
  type ConversationReplyErrorCode,
} from '../conversations/reply-service';
import { AuditRepository } from '../audit/audit';
import { LLMGateway } from '../ai/gateway/gateway';
import { SettingsRepository } from '../settings/settings';
import { SuggestReplyTask } from '../ai/tasks/suggest-reply-task';
import type { CustomerRepository } from '../customers/customer';
import type { LeadRepository } from '../leads/lead';
import type { DncRepository } from '../compliance/dnc';
import type { DispatchRepository } from '../notifications/dispatch-repository';
import type { MessageDeliveryProvider } from '../notifications/delivery-provider';

export interface ConversationRouterAiDeps {
  /** When present, enables POST /:id/suggest-reply (AI draft replies). */
  gateway?: LLMGateway;
  settingsRepo?: SettingsRepository;
}

/**
 * U6 — dependencies for the owner-authored outbound reply path. When present,
 * enables POST /:id/reply (free-text SMS/email send). Omitted (e.g. no delivery
 * provider configured) makes that route return 503 so the UI can hide it.
 */
export interface ConversationReplyRouterDeps {
  customerRepo: Pick<CustomerRepository, 'findById'>;
  leadRepo?: Pick<LeadRepository, 'findById'>;
  dncRepo: Pick<DncRepository, 'isOnDnc'>;
  dispatchRepo: Pick<DispatchRepository, 'create'>;
  delivery: MessageDeliveryProvider;
  settingsRepo?: SettingsRepository;
}

const replyBodySchema = z.object({
  body: z.string().min(1).max(5000),
  channel: z.enum(['sms', 'email']).optional(),
});

const inboxQuerySchema = z.object({
  status: z.enum(['open', 'closed', 'archived']).optional(),
  needsReplyOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Map a reply-service failure to an HTTP status the UI can act on. */
const REPLY_ERROR_STATUS: Record<ConversationReplyErrorCode, number> = {
  not_found: 404,
  empty_body: 400,
  no_recipient: 422,
  dnc_blocked: 403,
  delivery_failed: 502,
};

export function createConversationRouter(
  conversationRepo: ConversationRepository,
  auditRepo?: AuditRepository,
  aiDeps?: ConversationRouterAiDeps,
  replyDeps?: ConversationReplyRouterDeps,
  // When present, the get-or-create customer-thread route verifies the
  // customer exists (404s otherwise); omitted ⇒ the route still creates.
  customerLookup?: Pick<CustomerRepository, 'findById'>,
): Router {
  const router = Router();

  // Open (or lazily create) a customer's comms thread so the mobile app can
  // start texting a customer who has never messaged in. Idempotent: reuses the
  // existing thread, returning the same conversation on repeat taps.
  router.post(
    '/customer/:customerId',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const customerId = req.params.customerId;
      if (customerLookup) {
        const customer = await customerLookup.findById(tenantId, customerId);
        if (!customer) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
          return;
        }
      }
      const { conversation } = await getOrCreateCustomerConversation(
        conversationRepo,
        { tenantId, customerId, createdBy: req.auth!.userId, actorRole: req.auth!.role },
        auditRepo,
      );
      res.status(200).json({ conversation });
    }),
  );

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

  // U5 — unified inbox: list customer (+ unmatched phone) comms threads,
  // summarised by their newest message, with unanswered inbound threads first.
  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const query = inboxQuerySchema.parse(req.query);
      const threads = await conversationRepo.listInboxThreads(req.auth!.tenantId, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.needsReplyOnly !== undefined ? { needsReplyOnly: query.needsReplyOnly } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      res.json({ threads });
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
        tenantId,
      });

      res.status(200).json({ draft });
    })
  );

  // U6 — owner-authored outbound reply. Sends a free-text SMS/email to the
  // conversation's customer (or the originating number for an unmatched
  // thread), DNC-gated, and threads the outbound message back. Restricted to
  // owner/dispatcher (conversations:manage) — a customer-facing send, not an
  // internal note. Direct human-authored mutation, never a proposal.
  router.post(
    '/:id/reply',
    requireAuth,
    requireTenant,
    requirePermission('conversations:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      if (!replyDeps) {
        res
          .status(503)
          .json({ error: 'UNAVAILABLE', message: 'Messaging is not configured' });
        return;
      }
      const parsed = replyBodySchema.parse(req.body);
      const tenantId = req.auth!.tenantId;
      const settings = await replyDeps.settingsRepo?.findByTenant(tenantId);

      try {
        const result = await sendConversationReply(
          {
            conversationRepo,
            customerRepo: replyDeps.customerRepo,
            ...(replyDeps.leadRepo ? { leadRepo: replyDeps.leadRepo } : {}),
            dncRepo: replyDeps.dncRepo,
            dispatchRepo: replyDeps.dispatchRepo,
            delivery: replyDeps.delivery,
            auditRepo,
            ...(settings?.businessName ? { businessName: settings.businessName } : {}),
          },
          {
            tenantId,
            conversationId: req.params.id,
            body: parsed.body,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role,
            ...(parsed.channel ? { channel: parsed.channel } : {}),
          },
        );
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof ConversationReplyError) {
          res
            .status(REPLY_ERROR_STATUS[err.code])
            .json({ error: err.code.toUpperCase(), message: err.message });
          return;
        }
        throw err;
      }
    })
  );

  return router;
}
