import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';

export type LinkableEntityType =
  | 'customer'
  | 'job'
  | 'estimate'
  | 'invoice'
  | 'voice_session'
  | 'sms_conversation';

export interface ConversationLink {
  id: string;
  tenantId: string;
  conversationId: string;
  entityType: LinkableEntityType;
  entityId: string;
  createdAt: Date;
}

export interface CreateLinkInput {
  tenantId: string;
  conversationId: string;
  entityType: LinkableEntityType;
  entityId: string;
}

export interface ConversationLinkRepository {
  create(link: ConversationLink): Promise<ConversationLink>;
  findByConversation(tenantId: string, conversationId: string): Promise<ConversationLink[]>;
  findByEntity(tenantId: string, entityType: LinkableEntityType, entityId: string): Promise<ConversationLink[]>;
  delete(tenantId: string, id: string): Promise<boolean>;
}

export function validateLinkInput(input: CreateLinkInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.conversationId) errors.push('conversationId is required');
  if (!input.entityType) errors.push('entityType is required');
  const allowed: LinkableEntityType[] = [
    'customer',
    'job',
    'estimate',
    'invoice',
    'voice_session',
    'sms_conversation',
  ];
  if (input.entityType && !allowed.includes(input.entityType)) {
    errors.push('Invalid entityType');
  }
  if (!input.entityId) errors.push('entityId is required');
  return errors;
}

export async function linkConversation(
  input: CreateLinkInput,
  repository: ConversationLinkRepository
): Promise<ConversationLink> {
  const errors = validateLinkInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const link: ConversationLink = {
    id: uuidv4(),
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    entityType: input.entityType,
    entityId: input.entityId,
    createdAt: new Date(),
  };

  return repository.create(link);
}

export async function getConversationLinks(
  tenantId: string,
  conversationId: string,
  repository: ConversationLinkRepository
): Promise<ConversationLink[]> {
  return repository.findByConversation(tenantId, conversationId);
}

export async function getConversationsForEntity(
  tenantId: string,
  entityType: LinkableEntityType,
  entityId: string,
  repository: ConversationLinkRepository
): Promise<ConversationLink[]> {
  return repository.findByEntity(tenantId, entityType, entityId);
}

export class InMemoryConversationLinkRepository implements ConversationLinkRepository {
  private links: Map<string, ConversationLink> = new Map();

  async create(link: ConversationLink): Promise<ConversationLink> {
    // Mirror PgConversationLinkRepository: idempotent on the four-tuple
    // (ON CONFLICT DO NOTHING → return the canonical existing row).
    const existing = Array.from(this.links.values()).find(
      (l) =>
        l.tenantId === link.tenantId &&
        l.conversationId === link.conversationId &&
        l.entityType === link.entityType &&
        l.entityId === link.entityId,
    );
    if (existing) return { ...existing };
    this.links.set(link.id, { ...link });
    return { ...link };
  }

  async findByConversation(tenantId: string, conversationId: string): Promise<ConversationLink[]> {
    return Array.from(this.links.values())
      .filter((l) => l.tenantId === tenantId && l.conversationId === conversationId)
      .map((l) => ({ ...l }));
  }

  async findByEntity(tenantId: string, entityType: LinkableEntityType, entityId: string): Promise<ConversationLink[]> {
    return Array.from(this.links.values())
      .filter((l) => l.tenantId === tenantId && l.entityType === entityType && l.entityId === entityId)
      .map((l) => ({ ...l }));
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const l = this.links.get(id);
    if (!l || l.tenantId !== tenantId) return false;
    this.links.delete(id);
    return true;
  }
}
