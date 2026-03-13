import { v4 as uuidv4 } from 'uuid';

export interface EstimateLink {
  id: string;
  tenantId: string;
  conversationId: string;
  messageId?: string;
  proposalRevisionId?: string;
  estimateId: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateEstimateLinkInput {
  tenantId: string;
  conversationId: string;
  messageId?: string;
  proposalRevisionId?: string;
  estimateId: string;
  metadata?: Record<string, unknown>;
}

export interface EstimateLinkRepository {
  create(link: EstimateLink): Promise<EstimateLink>;
  findByConversation(tenantId: string, conversationId: string): Promise<EstimateLink[]>;
  findByEstimate(tenantId: string, estimateId: string): Promise<EstimateLink[]>;
  findById(tenantId: string, id: string): Promise<EstimateLink | null>;
}

export function validateEstimateLinkInput(input: Partial<CreateEstimateLinkInput>): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.conversationId) errors.push('conversationId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  return errors;
}

export function linkConversationToEstimate(input: CreateEstimateLinkInput): EstimateLink {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    proposalRevisionId: input.proposalRevisionId,
    estimateId: input.estimateId,
    metadata: input.metadata,
    createdAt: new Date(),
  };
}

export class InMemoryEstimateLinkRepository implements EstimateLinkRepository {
  private links: Map<string, EstimateLink> = new Map();

  async create(link: EstimateLink): Promise<EstimateLink> {
    this.links.set(link.id, { ...link });
    return link;
  }

  async findByConversation(tenantId: string, conversationId: string): Promise<EstimateLink[]> {
    return Array.from(this.links.values()).filter(
      (l) => l.tenantId === tenantId && l.conversationId === conversationId
    );
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<EstimateLink[]> {
    return Array.from(this.links.values()).filter(
      (l) => l.tenantId === tenantId && l.estimateId === estimateId
    );
  }

  async findById(tenantId: string, id: string): Promise<EstimateLink | null> {
    const link = this.links.get(id);
    if (!link || link.tenantId !== tenantId) return null;
    return { ...link };
  }
}
