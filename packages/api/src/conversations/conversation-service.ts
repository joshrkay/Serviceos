import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export type ConversationStatus = 'open' | 'closed' | 'archived';
export type MessageType = 'text' | 'transcript' | 'system_event' | 'note' | 'clarification' | 'proposal';

export interface Conversation {
  id: string;
  tenantId: string;
  title?: string;
  entityType?: string;
  entityId?: string;
  status: ConversationStatus;
  createdBy: string;
  assignedUserIds?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  tenantId: string;
  conversationId: string;
  messageType: MessageType;
  content?: string;
  senderId: string;
  senderRole: string;
  fileId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateConversationInput {
  tenantId: string;
  title?: string;
  entityType?: string;
  entityId?: string;
  createdBy: string;
}

export interface CreateMessageInput {
  tenantId: string;
  conversationId: string;
  messageType: MessageType;
  content?: string;
  senderId: string;
  senderRole: string;
  fileId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

/**
 * U5 — one row in the unified communication inbox: a customer (or unmatched
 * phone) thread, summarised by its most recent message so the owner can triage
 * which conversations need a reply without opening each one.
 */
export interface InboxThreadSummary {
  conversation: Conversation;
  /** ISO timestamp of the most recent message (threads always have ≥1). */
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageDirection: 'inbound' | 'outbound';
  /** True when the most recent message is inbound — the owner owes a reply. */
  needsReply: boolean;
  messageCount: number;
  /** Display name when the thread is linked to a customer. */
  customerName?: string;
}

/** Entity types surfaced in the comms inbox (customer threads + phone-keyed
 *  unmatched threads). Other conversation kinds (voice/proposal internals) are
 *  excluded. Kept here so the repo and any caller agree on the scope. */
export const INBOX_ENTITY_TYPES = ['customer', 'sms_unmatched'] as const;

export interface ListInboxThreadsOptions {
  status?: ConversationStatus;
  needsReplyOnly?: boolean;
  limit?: number;
}

export interface ConversationRepository {
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  findById(tenantId: string, id: string): Promise<Conversation | null>;
  findByEntity(tenantId: string, entityType: string, entityId: string): Promise<Conversation[]>;
  addMessage(input: CreateMessageInput): Promise<Message>;
  getMessages(tenantId: string, conversationId: string): Promise<Message[]>;
  updateMessageMetadata(tenantId: string, messageId: string, metadata: Record<string, unknown>): Promise<Message | null>;
  /** U5 — list comms threads (customer + unmatched) for the inbox surface. */
  listInboxThreads(
    tenantId: string,
    options?: ListInboxThreadsOptions,
  ): Promise<InboxThreadSummary[]>;
}

/** Direction of a message: explicit metadata.direction, else inferred from the
 *  sender role ('customer' ⇒ inbound). Shared by the repos so inbox + timeline
 *  classify identically. */
export function messageDirection(message: Message): 'inbound' | 'outbound' {
  const dir = (message.metadata ?? {})['direction'];
  if (dir === 'inbound' || dir === 'outbound') return dir;
  return message.senderRole === 'customer' ? 'inbound' : 'outbound';
}

export function validateCreateConversation(input: CreateConversationInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  return errors;
}

export async function createConversationWithAudit(
  input: CreateConversationInput,
  repository: ConversationRepository,
  auditRepo?: AuditRepository,
  actorRole?: string,
): Promise<Conversation> {
  const created = await repository.createConversation(input);

  if (auditRepo) {
    const event = createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.createdBy,
      actorRole: actorRole ?? 'unknown',
      eventType: 'conversation.created',
      entityType: 'conversation',
      entityId: created.id,
      metadata: {
        entityType: created.entityType,
        entityId: created.entityId,
      },
    });
    await auditRepo.create(event);
  }

  return created;
}

export function validateCreateMessage(input: CreateMessageInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.conversationId) errors.push('conversationId is required');
  if (!input.messageType) errors.push('messageType is required');
  if (!['text', 'transcript', 'system_event', 'note', 'clarification', 'proposal'].includes(input.messageType)) {
    errors.push('Invalid messageType');
  }
  if (!input.senderId) errors.push('senderId is required');
  if (!input.senderRole) errors.push('senderRole is required');
  if (input.messageType === 'text' && !input.content) {
    errors.push('content is required for text messages');
  }
  return errors;
}

export class InMemoryConversationRepository implements ConversationRepository {
  private conversations: Map<string, Conversation> = new Map();
  private messages: Message[] = [];

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const conv: Conversation = {
      id: uuidv4(),
      tenantId: input.tenantId,
      title: input.title,
      entityType: input.entityType,
      entityId: input.entityId,
      status: 'open',
      createdBy: input.createdBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.conversations.set(conv.id, conv);
    return conv;
  }

  async findById(tenantId: string, id: string): Promise<Conversation | null> {
    const conv = this.conversations.get(id);
    if (!conv || conv.tenantId !== tenantId) return null;
    return { ...conv };
  }

  async findByEntity(tenantId: string, entityType: string, entityId: string): Promise<Conversation[]> {
    return Array.from(this.conversations.values()).filter(
      (c) => c.tenantId === tenantId && c.entityType === entityType && c.entityId === entityId
    );
  }

  async addMessage(input: CreateMessageInput): Promise<Message> {
    const msg: Message = {
      id: uuidv4(),
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageType: input.messageType,
      content: input.content,
      senderId: input.senderId,
      senderRole: input.senderRole,
      fileId: input.fileId,
      source: input.source,
      metadata: input.metadata,
      createdAt: new Date(),
    };
    this.messages.push(msg);
    return msg;
  }

  async getMessages(tenantId: string, conversationId: string): Promise<Message[]> {
    return this.messages.filter(
      (m) => m.tenantId === tenantId && m.conversationId === conversationId
    );
  }

  async updateMessageMetadata(
    tenantId: string,
    messageId: string,
    metadata: Record<string, unknown>
  ): Promise<Message | null> {
    const idx = this.messages.findIndex((m) => m.id === messageId && m.tenantId === tenantId);
    if (idx === -1) return null;
    this.messages[idx] = {
      ...this.messages[idx],
      metadata: { ...this.messages[idx].metadata, ...metadata },
    };
    return { ...this.messages[idx] };
  }

  async listInboxThreads(
    tenantId: string,
    options: ListInboxThreadsOptions = {},
  ): Promise<InboxThreadSummary[]> {
    const limit = options.limit ?? 50;
    const summaries: InboxThreadSummary[] = [];
    for (const conv of this.conversations.values()) {
      if (conv.tenantId !== tenantId) continue;
      if (!INBOX_ENTITY_TYPES.includes(conv.entityType as (typeof INBOX_ENTITY_TYPES)[number])) {
        continue;
      }
      if (options.status && conv.status !== options.status) continue;
      const msgs = this.messages
        .filter((m) => m.tenantId === tenantId && m.conversationId === conv.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (msgs.length === 0) continue;
      const last = msgs[msgs.length - 1];
      const direction = messageDirection(last);
      const needsReply = direction === 'inbound';
      if (options.needsReplyOnly && !needsReply) continue;
      summaries.push({
        conversation: { ...conv },
        lastMessageAt: last.createdAt.toISOString(),
        lastMessagePreview: (last.content ?? '').slice(0, 160),
        lastMessageDirection: direction,
        needsReply,
        messageCount: msgs.length,
      });
    }
    return summaries
      .sort((a, b) => {
        if (a.needsReply !== b.needsReply) return a.needsReply ? -1 : 1;
        return b.lastMessageAt.localeCompare(a.lastMessageAt);
      })
      .slice(0, limit);
  }
}
