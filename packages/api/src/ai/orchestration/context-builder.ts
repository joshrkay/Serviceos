import { Message } from '../../conversations/conversation-service';
import { VerticalType } from '../../shared/vertical-types';
import type { KnowledgeChunkSourceType } from '../training/knowledge-chunks';
import type { RetrieveContextResult } from '../skills/retrieve-context';
import { createLogger } from '../../logging/logger';
import { classifyMessageProvenance } from '../content-provenance';
import { buildUntrustedContentSection } from '../untrusted-content';

const logger = createLogger({
  service: 'ai.orchestration.context-builder',
  environment: process.env.NODE_ENV || 'development',
});

export interface VerticalContext {
  type: VerticalType;
  packId: string;
  terminology?: Record<string, unknown>;
  categories?: unknown[];
  templates?: unknown[];
  intakeConfig?: Record<string, unknown>;
}

/**
 * A retrieved RAG chunk surfaced into the prompt context. Carries only
 * the scrubbed content plus minimal provenance — the embedding vector
 * and raw content stay in the repository. Phase 4a-2 wires a `retrieve`
 * adapter into `buildSourceContext` so callers behind the
 * `RAG_RETRIEVAL_ENABLED` flag get this populated; otherwise it stays
 * undefined and downstream consumers fall through to the legacy
 * recency-only path.
 */
export interface RetrievedChunk {
  content: string;
  sourceType: string;
  sourceId: string;
  similarity: number;
}

export interface SourceContext {
  conversation?: {
    id: string;
    recentMessages: Array<{ role: string; content: string; createdAt: Date }>;
  };
  customer?: Record<string, unknown>;
  job?: Record<string, unknown>;
  location?: Record<string, unknown>;
  tenant?: { name: string; settings?: Record<string, unknown> };
  vertical?: VerticalContext;
  retrievedChunks?: RetrievedChunk[];
}

export interface EntityRefs {
  customerId?: string;
  jobId?: string;
  locationId?: string;
  /**
   * Explicit query text for retrieval. When omitted, `buildSourceContext`
   * falls back to the latest user message in `conversation.recentMessages`.
   */
  queryText?: string;
}

/**
 * Adapter signature for the optional retrieval dependency. Wraps the
 * `retrieve-context` skill so the context-builder doesn't depend
 * directly on `EmbeddingProvider` / `KnowledgeChunkRepository`. Failure
 * is encoded in the result (`status: 'unavailable'`) — callers must not
 * throw.
 */
export type RetrieveAdapter = (input: {
  tenantId: string;
  queryText: string;
  k?: number;
  sourceTypes?: KnowledgeChunkSourceType[];
  minSimilarity?: number;
}) => Promise<RetrieveContextResult>;

export interface VerticalConfigResult {
  type: VerticalType;
  packId: string;
  terminology: Record<string, unknown>;
  categories: unknown[];
  templates: unknown[];
  intakeConfig: Record<string, unknown>;
}

export interface ContextRepositories {
  getConversationMessages?(tenantId: string, conversationId: string): Promise<Message[]>;
  getCustomer?(tenantId: string, customerId: string): Promise<Record<string, unknown> | null>;
  getJob?(tenantId: string, jobId: string): Promise<Record<string, unknown> | null>;
  getLocation?(tenantId: string, locationId: string): Promise<Record<string, unknown> | null>;
  getTenantInfo?(tenantId: string): Promise<{ name: string; settings?: Record<string, unknown> } | null>;
  getActiveVerticalConfig?(tenantId: string): Promise<VerticalConfigResult | null>;
  /**
   * Optional RAG retrieval adapter. When supplied (typically gated by
   * `RAG_RETRIEVAL_ENABLED` in app.ts), `buildSourceContext` resolves a
   * `queryText` from `entityRefs.queryText` or the latest user/customer
   * message and populates `SourceContext.retrievedChunks`. Failure-soft:
   * `status: 'unavailable'` leaves the field undefined and the rest of
   * the context still builds normally.
   */
  retrieve?: RetrieveAdapter;
}

export const MAX_CONTEXT_TOKENS = 8000;

const MAX_RECENT_MESSAGES = 20;
const DEFAULT_RETRIEVAL_K = 5;

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

  if (repos.getActiveVerticalConfig) {
    try {
      const verticalConfig = await repos.getActiveVerticalConfig(tenantId);
      if (verticalConfig) {
        context.vertical = {
          type: verticalConfig.type,
          packId: verticalConfig.packId,
          terminology: verticalConfig.terminology,
          categories: verticalConfig.categories,
          templates: verticalConfig.templates,
          intakeConfig: verticalConfig.intakeConfig,
        };
      }
    } catch (err) {
      logger.error('Failed to load vertical config for tenant', { tenantId, err });
    }
  }

  if (repos.retrieve) {
    const queryText = resolveQueryText(entityRefs, context);
    if (queryText) {
      try {
        const result = await repos.retrieve({
          tenantId,
          queryText,
          k: DEFAULT_RETRIEVAL_K,
        });
        if (result.status === 'ok') {
          context.retrievedChunks = result.hits.map((hit) => ({
            content: hit.chunk.contentScrubbed,
            sourceType: hit.chunk.sourceType,
            sourceId: hit.chunk.sourceId,
            similarity: hit.similarity,
          }));
        }
        // 'no_hits' and 'unavailable' both leave retrievedChunks undefined.
      } catch (err) {
        // The adapter contract is failure-soft, but defend against
        // adapters that throw synchronously (e.g., misconfigured deps).
        logger.error('context-builder: retrieve adapter threw', { tenantId, err });
      }
    }
  }

  return context;
}

/**
 * RIVET I13 — turn `SourceContext.conversation.recentMessages` into prompt
 * sections with the customer-authored lines fenced.
 *
 * `recentMessages` is a STRUCTURED field (UI, tests, and non-prompt code read
 * `content` verbatim), so fencing never happens inside `buildSourceContext`
 * itself. Instead, every prompt-assembly consumer of the thread calls this
 * one helper: trusted (tenant/system-authored) lines come back as plain
 * `Role: content` strings for the consumer to format freely, and ALL
 * customer-authored lines come back as a single ready-to-inject block
 * rendered through `buildUntrustedContentSection` — quoted DATA, never
 * instructions. `untrustedBlock` is absent when no customer messages exist so
 * consumers can spread it conditionally and stay byte-identical.
 *
 * Inject the block into the LOWEST-authority prompt slot (inside the user
 * message — never a system message, which would raise the caller text's
 * instruction priority). Hand-rolling thread formatting at a consumer instead
 * of calling this is exactly the "forget the fence" failure mode I13 exists
 * to prevent.
 */
export function buildRecentMessagesPromptSections(
  recentMessages: ReadonlyArray<{ role: string; content: string }>,
): { trustedLines: string[]; untrustedBlock?: string } {
  const trustedLines: string[] = [];
  const untrusted: string[] = [];
  for (const m of recentMessages) {
    const content = m.content?.trim();
    if (!content) continue;
    if (classifyMessageProvenance({ senderRole: m.role }) === 'untrusted') {
      untrusted.push(`Customer: ${content}`);
    } else {
      trustedLines.push(`${m.role}: ${content}`);
    }
  }
  return {
    trustedLines,
    ...(untrusted.length > 0
      ? {
          untrustedBlock: buildUntrustedContentSection(
            untrusted.join('\n'),
            'Customer messages in this conversation',
          ),
        }
      : {}),
  };
}

/**
 * Roles whose latest message is treated as the retrieval query.
 * Allow-list (not exclude-list of agent/assistant) so that future
 * roles like 'system' or 'tool' don't accidentally drive retrieval.
 * Adding a new role here is a deliberate one-line change.
 */
const QUERY_ROLES: ReadonlySet<string> = new Set(['customer', 'user']);

/**
 * Bound on the embedding-query length. Defense against a pathologically long
 * customer message becoming the retrieval query (embedding cost/latency) —
 * NOT an injection control; see the I13 note on `resolveQueryText`.
 */
export const MAX_QUERY_CHARS = 512;

/**
 * RIVET I13 — deliberately UNFENCED. The returned text reaches ONLY
 * `EmbeddingProvider.createEmbedding()` (nearest-neighbor retrieval); it is
 * never rendered into a chat-completion prompt slot, so it has no
 * instruction-eligible exposure. Wrapping it in the untrusted-content fence
 * would let the ~400-char hardening sentence dominate a short query's
 * embedding and silently degrade retrieval tenant-wide. If this text is ever
 * reused in an LLM prompt (e.g. a query-rewrite step), it MUST go through
 * `buildUntrustedContentSection` at that new call site.
 */
function resolveQueryText(
  entityRefs: EntityRefs,
  context: SourceContext,
): string | undefined {
  const explicit = entityRefs.queryText?.trim();
  if (explicit && explicit.length > 0) return explicit.slice(0, MAX_QUERY_CHARS);
  const messages = context.conversation?.recentMessages;
  if (!messages || messages.length === 0) return undefined;
  // Walk from newest to oldest, picking the latest message from a
  // QUERY_ROLES sender — that's the actual question we're answering.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (QUERY_ROLES.has(m.role)) {
      const text = m.content?.trim();
      if (text && text.length > 0) return text.slice(0, MAX_QUERY_CHARS);
    }
  }
  return undefined;
}

export function estimateContextSize(context: SourceContext): number {
  return Math.ceil(JSON.stringify(context).length / 4);
}

export function trimContext(context: SourceContext, maxTokens: number = MAX_CONTEXT_TOKENS): SourceContext {
  let trimmed: SourceContext = { ...context };

  if (estimateContextSize(trimmed) <= maxTokens) {
    return trimmed;
  }

  // Drop retrieved RAG chunks first. Recency from `conversation` is the
  // strong signal for in-flight calls; retrieval is augmentation. If we
  // can't fit both, the conversation wins. The `length > 0` guard is
  // defensive: the current adapter never emits an empty array (it leaves
  // the field undefined on no_hits/unavailable), but a future direct
  // mutation could land an empty array here, and we don't want to
  // delete a no-op field that was already harmless.
  if (trimmed.retrievedChunks && trimmed.retrievedChunks.length > 0) {
    trimmed = { ...trimmed };
    delete trimmed.retrievedChunks;
  }

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
