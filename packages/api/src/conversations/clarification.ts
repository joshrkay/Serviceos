import { v4 as uuidv4 } from 'uuid';
import { ConversationRepository, CreateMessageInput, Message } from './conversation-service';

export interface ClarificationRequest {
  id: string;
  conversationId: string;
  messageId?: string;
  questions: string[];
  originalTaskContext: Record<string, unknown>;
  status: 'pending' | 'responded' | 'expired';
  createdAt: Date;
}

export interface ClarificationStore {
  save(request: ClarificationRequest): Promise<ClarificationRequest>;
  findById(id: string): Promise<ClarificationRequest | null>;
  findByConversation(conversationId: string): Promise<ClarificationRequest[]>;
  updateStatus(id: string, status: ClarificationRequest['status']): Promise<ClarificationRequest | null>;
}

export class InMemoryClarificationStore implements ClarificationStore {
  private requests: Map<string, ClarificationRequest> = new Map();

  async save(request: ClarificationRequest): Promise<ClarificationRequest> {
    this.requests.set(request.id, { ...request });
    return { ...request };
  }

  async findById(id: string): Promise<ClarificationRequest | null> {
    const request = this.requests.get(id);
    if (!request) return null;
    return { ...request };
  }

  async findByConversation(conversationId: string): Promise<ClarificationRequest[]> {
    return Array.from(this.requests.values())
      .filter((r) => r.conversationId === conversationId)
      .map((r) => ({ ...r }));
  }

  async updateStatus(
    id: string,
    status: ClarificationRequest['status']
  ): Promise<ClarificationRequest | null> {
    const request = this.requests.get(id);
    if (!request) return null;
    request.status = status;
    this.requests.set(id, request);
    return { ...request };
  }
}

const SENSITIVE_KEY_PATTERNS = ['password', 'secret', 'apikey', 'token', 'credential', 'authorization'];

function sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).filter(([key]) =>
      !SENSITIVE_KEY_PATTERNS.some((pattern) => key.toLowerCase().includes(pattern))
    )
  );
}

export async function requestClarification(
  conversationRepo: ConversationRepository,
  store: ClarificationStore,
  tenantId: string,
  conversationId: string,
  questions: string[],
  originalTaskContext: Record<string, unknown>,
  userId: string
): Promise<ClarificationRequest> {
  const message = await conversationRepo.addMessage({
    tenantId,
    conversationId,
    messageType: 'system_event',
    content: questions.join('\n'),
    senderId: userId,
    senderRole: 'system',
    metadata: { type: 'clarification_request', questions },
  });

  const request: ClarificationRequest = {
    id: uuidv4(),
    conversationId,
    messageId: message.id,
    questions,
    originalTaskContext: sanitizeContext(originalTaskContext),
    status: 'pending',
    createdAt: new Date(),
  };

  return store.save(request);
}

export async function handleClarificationResponse(
  store: ClarificationStore,
  clarificationId: string,
  response: string
): Promise<{ originalContext: Record<string, unknown>; enrichedContext: Record<string, unknown> }> {
  const request = await store.findById(clarificationId);
  if (!request) {
    throw new Error(`Clarification request not found: ${clarificationId}`);
  }

  await store.updateStatus(clarificationId, 'responded');

  return {
    originalContext: request.originalTaskContext,
    enrichedContext: {
      ...request.originalTaskContext,
      clarificationResponse: response,
      clarificationId: request.id,
      clarificationQuestions: request.questions,
    },
  };
}
