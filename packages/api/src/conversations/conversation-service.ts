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

/** Entity types surfaced in the comms inbox: customer threads, lead threads
 *  (unknown-caller captures), and phone-keyed unmatched threads. Other
 *  conversation kinds (voice/proposal internals) are excluded. Kept here so the
 *  repo and any caller agree on the scope. */
export const INBOX_ENTITY_TYPES = ['customer', 'lead', 'sms_unmatched'] as const;

export interface ListInboxThreadsOptions {
  status?: ConversationStatus;
  needsReplyOnly?: boolean;
  limit?: number;
}

/**
 * Story 3.11 — a message that matched a history search, with the minimal
 * conversation context the UI needs to label it and deep-link into the thread.
 */
export interface MessageSearchHit {
  message: Message;
  conversation: Pick<Conversation, 'id' | 'title' | 'entityType' | 'entityId'>;
}

/**
 * Story 3.11 — history search params: free-text content match and/or a
 * linked-entity filter (customer or job). All optional; an empty query returns
 * the most recent messages for the tenant.
 */
export interface MessageSearchParams {
  text?: string;
  entityType?: string;
  entityId?: string;
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
  /**
   * Story 3.11 — search message history by free text and/or linked entity
   * (customer/job). Tenant-scoped; newest first. Drives the history search UI.
   */
  searchMessages(tenantId: string, params: MessageSearchParams): Promise<MessageSearchHit[]>;
  /**
   * Story 3.11 follow-up (U9) — atomically create a conversation and its first
   * messages in a single transaction, so a failed message insert can't leave an
   * orphaned empty conversation. Optional capability: callers fall back to a
   * sequential create + addMessage when a repo doesn't implement it (only the
   * Postgres repo needs real transactional atomicity).
   */
  createConversationWithMessages?(
    conversation: CreateConversationInput,
    messages: Array<Omit<CreateMessageInput, 'conversationId'>>,
  ): Promise<{ conversation: Conversation; messages: Message[] }>;
}

/**
 * Story 3.11 — persist one assistant chat turn (the operator's message + the
 * agent's reply) so the running conversation survives reload and is searchable.
 * Get-or-create: reuse the supplied conversation when it exists, else open a new
 * one titled from the first message. Returns the conversation id so the client
 * can pin it for subsequent turns. The agent reply is only written when present
 * (a clarifying/empty reply still records the operator's turn).
 */
export async function recordAssistantTurn(
  repository: ConversationRepository,
  input: {
    tenantId: string;
    userId: string;
    conversationId?: string;
    userText: string;
    assistantText?: string;
  },
  auditRepo?: AuditRepository,
): Promise<string> {
  const existing =
    input.conversationId != null
      ? await repository.findById(input.tenantId, input.conversationId)
      : null;

  // The turn's messages (operator first, then agent when present).
  const turnMessages: Array<Omit<CreateMessageInput, 'conversationId'>> = [];
  if (input.userText) {
    turnMessages.push({
      tenantId: input.tenantId,
      messageType: 'text',
      content: input.userText,
      senderId: input.userId,
      senderRole: 'user',
      source: 'assistant',
    });
  }
  if (input.assistantText) {
    turnMessages.push({
      tenantId: input.tenantId,
      messageType: 'text',
      content: input.assistantText,
      senderId: 'assistant',
      senderRole: 'assistant',
      source: 'assistant',
    });
  }

  // Existing thread: append in place (no orphan risk — the conversation already
  // exists, so a failed message insert can't leave a dangling empty thread).
  if (existing) {
    for (const m of turnMessages) {
      await repository.addMessage({ ...m, conversationId: existing.id });
    }
    return existing.id;
  }

  // New thread: create the conversation and its first messages ATOMICALLY when
  // the repo supports it, so a failed message insert can't orphan an empty
  // conversation. Fall back to sequential create + addMessage otherwise.
  const conversationInput: CreateConversationInput = {
    tenantId: input.tenantId,
    createdBy: input.userId,
    ...(input.userText ? { title: input.userText.slice(0, 80) } : {}),
  };

  let conversation: Conversation;
  if (repository.createConversationWithMessages) {
    const result = await repository.createConversationWithMessages(
      conversationInput,
      turnMessages,
    );
    conversation = result.conversation;
  } else {
    conversation = await repository.createConversation(conversationInput);
    for (const m of turnMessages) {
      await repository.addMessage({ ...m, conversationId: conversation.id });
    }
  }

  // Emit the conversation.created audit (mirrors createConversationWithAudit;
  // emitted after the create so an audit failure never rolls back the thread).
  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.userId,
        actorRole: 'owner',
        eventType: 'conversation.created',
        entityType: 'conversation',
        entityId: conversation.id,
        metadata: {
          entityType: conversation.entityType,
          entityId: conversation.entityId,
        },
      }),
    );
  }

  return conversation.id;
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
  repository: Pick<ConversationRepository, 'createConversation'>,
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

/**
 * True for a Postgres unique-violation (SQLSTATE 23505). Used to recover from a
 * lost get-or-create race against the partial unique index on active threads.
 * Pure + exported so the recovery path is unit-tested without a database.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}

/**
 * Return the customer's existing comms thread, or create one. Used by the
 * "Message this customer" mobile action and the outbound-call logger so a
 * customer with no prior inbound text still has a single thread to attach to
 * (vs. client-side create-then-reply, which would race into duplicate threads).
 * Prefers a non-archived thread; falls back to the newest existing one.
 */
export async function getOrCreateCustomerConversation(
  repository: ConversationRepository,
  input: { tenantId: string; customerId: string; createdBy: string; actorRole?: string; title?: string },
  auditRepo?: AuditRepository,
): Promise<{ conversation: Conversation; created: boolean }> {
  const existing = await repository.findByEntity(input.tenantId, 'customer', input.customerId);
  const open = existing.find((c) => c.status !== 'archived') ?? existing[0];
  if (open) return { conversation: open, created: false };
  try {
    const conversation = await createConversationWithAudit(
      {
        tenantId: input.tenantId,
        entityType: 'customer',
        entityId: input.customerId,
        createdBy: input.createdBy,
        ...(input.title ? { title: input.title } : {}),
      },
      repository,
      auditRepo,
      input.actorRole,
    );
    return { conversation, created: true };
  } catch (err) {
    // Lost a concurrent get-or-create race: another request created the open
    // thread between our findByEntity and this INSERT. The partial unique index
    // (migration 198 — one open thread per customer) rejects the duplicate with
    // 23505. Re-read and return the winner rather than surfacing the error or
    // splitting later messages/calls across duplicate customer threads.
    if (!isUniqueViolation(err)) throw err;
    const after = await repository.findByEntity(input.tenantId, 'customer', input.customerId);
    const winner = after.find((c) => c.status !== 'archived') ?? after[0];
    if (winner) return { conversation: winner, created: false };
    throw err;
  }
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

  async createConversationWithMessages(
    conversation: CreateConversationInput,
    messages: Array<Omit<CreateMessageInput, 'conversationId'>>,
  ): Promise<{ conversation: Conversation; messages: Message[] }> {
    const created = await this.createConversation(conversation);
    const out: Message[] = [];
    for (const m of messages) {
      out.push(await this.addMessage({ ...m, conversationId: created.id }));
    }
    return { conversation: created, messages: out };
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

  async searchMessages(
    tenantId: string,
    params: MessageSearchParams,
  ): Promise<MessageSearchHit[]> {
    const limit = params.limit ?? 50;
    const needle = params.text?.trim().toLowerCase();
    const hits: MessageSearchHit[] = [];
    for (const m of this.messages) {
      if (m.tenantId !== tenantId) continue;
      if (needle && !(m.content ?? '').toLowerCase().includes(needle)) continue;
      const conv = this.conversations.get(m.conversationId);
      if (!conv || conv.tenantId !== tenantId) continue;
      if (params.entityType && conv.entityType !== params.entityType) continue;
      if (params.entityId && conv.entityId !== params.entityId) continue;
      hits.push({
        message: { ...m },
        conversation: {
          id: conv.id,
          title: conv.title,
          entityType: conv.entityType,
          entityId: conv.entityId,
        },
      });
    }
    return hits
      .sort((a, b) => b.message.createdAt.getTime() - a.message.createdAt.getTime())
      .slice(0, limit);
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
