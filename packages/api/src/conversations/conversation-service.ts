import { v4 as uuidv4 } from 'uuid';

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

export interface ConversationRepository {
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  findById(tenantId: string, id: string): Promise<Conversation | null>;
  findByEntity(tenantId: string, entityType: string, entityId: string): Promise<Conversation[]>;
  addMessage(input: CreateMessageInput): Promise<Message>;
  getMessages(tenantId: string, conversationId: string): Promise<Message[]>;
  updateMessageMetadata(tenantId: string, messageId: string, metadata: Record<string, unknown>): Promise<Message | null>;
}

export function validateCreateConversation(input: CreateConversationInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  return errors;
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
}
