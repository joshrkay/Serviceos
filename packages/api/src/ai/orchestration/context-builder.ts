import { Message } from '../../conversations/conversation-service';

export interface SourceContext {
  conversation?: {
    id: string;
    recentMessages: Array<{ role: string; content: string; createdAt: Date }>;
  };
  customer?: Record<string, unknown>;
  job?: Record<string, unknown>;
  location?: Record<string, unknown>;
  tenant?: { name: string; settings?: Record<string, unknown> };
}

export interface EntityRefs {
  customerId?: string;
  jobId?: string;
  locationId?: string;
}

export interface ContextRepositories {
  getConversationMessages?(tenantId: string, conversationId: string): Promise<Message[]>;
  getCustomer?(tenantId: string, customerId: string): Promise<Record<string, unknown> | null>;
  getJob?(tenantId: string, jobId: string): Promise<Record<string, unknown> | null>;
  getLocation?(tenantId: string, locationId: string): Promise<Record<string, unknown> | null>;
  getTenantInfo?(tenantId: string): Promise<{ name: string; settings?: Record<string, unknown> } | null>;
}

export const MAX_CONTEXT_TOKENS = 8000;

const MAX_RECENT_MESSAGES = 20;

export async function buildSourceContext(
  tenantId: string,
  conversationId: string | undefined,
  entityRefs: EntityRefs,
  repos: ContextRepositories
): Promise<SourceContext> {
  const context: SourceContext = {};

  if (conversationId && repos.getConversationMessages) {
    const messages = await repos.getConversationMessages(tenantId, conversationId);
    const recent = messages.slice(-MAX_RECENT_MESSAGES);
    context.conversation = {
      id: conversationId,
      recentMessages: recent.map((m) => ({
        role: m.senderRole,
        content: m.content ?? '',
        createdAt: m.createdAt,
      })),
    };
  }

  if (entityRefs.customerId && repos.getCustomer) {
    const customer = await repos.getCustomer(tenantId, entityRefs.customerId);
    if (customer) {
      context.customer = customer;
    }
  }

  if (entityRefs.jobId && repos.getJob) {
    const job = await repos.getJob(tenantId, entityRefs.jobId);
    if (job) {
      context.job = job;
    }
  }

  if (entityRefs.locationId && repos.getLocation) {
    const location = await repos.getLocation(tenantId, entityRefs.locationId);
    if (location) {
      context.location = location;
    }
  }

  if (repos.getTenantInfo) {
    const tenant = await repos.getTenantInfo(tenantId);
    if (tenant) {
      context.tenant = tenant;
    }
  }

  return context;
}

export function estimateContextSize(context: SourceContext): number {
  return Math.ceil(JSON.stringify(context).length / 4);
}

export function trimContext(context: SourceContext, maxTokens: number = MAX_CONTEXT_TOKENS): SourceContext {
  let trimmed: SourceContext = { ...context };

  if (estimateContextSize(trimmed) <= maxTokens) {
    return trimmed;
  }

  // Trim oldest messages first
  if (trimmed.conversation) {
    trimmed = {
      ...trimmed,
      conversation: {
        ...trimmed.conversation,
        recentMessages: [...trimmed.conversation.recentMessages],
      },
    };

    while (
      trimmed.conversation!.recentMessages.length > 1 &&
      estimateContextSize(trimmed) > maxTokens
    ) {
      trimmed.conversation!.recentMessages.shift();
    }
  }

  if (estimateContextSize(trimmed) <= maxTokens) {
    return trimmed;
  }

  // Remove optional fields in order: location, job, customer
  if (trimmed.location) {
    trimmed = { ...trimmed };
    delete trimmed.location;
  }

  if (estimateContextSize(trimmed) <= maxTokens) {
    return trimmed;
  }

  if (trimmed.job) {
    trimmed = { ...trimmed };
    delete trimmed.job;
  }

  if (estimateContextSize(trimmed) <= maxTokens) {
    return trimmed;
  }

  if (trimmed.customer) {
    trimmed = { ...trimmed };
    delete trimmed.customer;
  }

  return trimmed;
}
