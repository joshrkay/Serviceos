import { Pool, PoolClient } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';

/**
 * Repository for `knowledge_chunks` — the unified per-tenant + global
 * RAG corpus introduced in migration `059_create_knowledge_chunks`.
 *
 * Phase 1 surface: insert + similarity search. Ingestion workers
 * (transcript / proposal-correction / tenant-knowledge-seed) and the
 * retrieval skill in `ai/skills/retrieve-context.ts` consume this
 * interface. No caller in main reads or writes today; wiring lands in
 * Phases 3b and 4a.
 *
 * Tenant scoping: the RLS policy on `knowledge_chunks` allows a row to
 * be visible iff `tenant_id IS NULL` (global tier) OR `tenant_id`
 * matches the request's `app.current_tenant_id` GUC. Search runs
 * inside `withTenant(tenantId, ...)` so the policy yields both tiers
 * in a single query without an explicit UNION.
 *
 * Idempotency: every insert uses `ON CONFLICT (scope, source_type,
 * source_id, source_version) DO UPDATE` so the seed workers can
 * safely re-fire on the same source row (e.g., catalog item edited
 * thrice in 60s — the coalescer in Phase 3b leaves at most one queue
 * job, but defense in depth here makes the worker idempotent
 * regardless).
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type KnowledgeChunkScope = 'tenant' | 'global';

/**
 * Whitelist of source-type strings used by ingestion workers. Kept here
 * (rather than in each worker) so the repository can validate inputs
 * and so the eventual analytics surface has a single source of truth.
 * Adding a new source type is a deliberate change to this file plus
 * the workers that emit it.
 */
export type KnowledgeChunkSourceType =
  | 'call_summary'
  | 'transcript_window'
  | 'proposal_correction'
  | 'catalog_item'
  | 'estimate_template'
  | 'service_bundle'
  | 'wording_preference'
  | 'tenant_setting'
  | 'vertical_terminology'
  | 'vertical_category'
  | 'vertical_training_asset'
  | 'vertical_eval_scenario'
  | 'vertical_labeled_call_example';

export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_MODEL = 'text-embedding-3-small' as const;

export interface KnowledgeChunkInput {
  /** NULL for `scope='global'`, required UUID for `scope='tenant'`. */
  tenantId: string | null;
  scope: KnowledgeChunkScope;
  sourceType: KnowledgeChunkSourceType;
  sourceId: string;
  sourceVersion?: number;
  content: string;
  contentScrubbed: string;
  embedding: number[];
  embeddingModel?: typeof EMBEDDING_MODEL;
  chunkSchemaVersion?: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeChunk {
  id: string;
  tenantId: string | null;
  scope: KnowledgeChunkScope;
  sourceType: string;
  sourceId: string;
  sourceVersion: number;
  content: string;
  contentScrubbed: string;
  embedding: number[];
  embeddingModel: string;
  chunkSchemaVersion: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchOptions {
  /** Required even when looking only for global hits — the RLS GUC must be set. */
  tenantId: string;
  queryEmbedding: number[];
  /** When set, restricts results to these source types. */
  sourceTypes?: KnowledgeChunkSourceType[];
  /** Default 5; capped at 50. */
  k?: number;
  /** Cosine similarity floor in [0, 1]. Default 0.75 → distance ≤ 0.25. */
  minSimilarity?: number;
}

export interface SearchHit {
  chunk: KnowledgeChunk;
  /** Cosine similarity in [0, 1]. 1.0 = identical direction. */
  similarity: number;
}

export interface KnowledgeChunkRepository {
  insert(input: KnowledgeChunkInput): Promise<KnowledgeChunk>;
  search(opts: SearchOptions): Promise<SearchHit[]>;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const DEFAULT_K = 5;
const MAX_K = 50;
const DEFAULT_MIN_SIMILARITY = 0.75;

function validateInput(input: KnowledgeChunkInput): void {
  if (input.embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `knowledge_chunks: embedding length ${input.embedding.length} != expected ${EMBEDDING_DIMENSIONS}`,
    );
  }
  const model = input.embeddingModel ?? EMBEDDING_MODEL;
  if (model !== EMBEDDING_MODEL) {
    throw new Error(`knowledge_chunks: embedding_model must be ${EMBEDDING_MODEL} (v1 lock)`);
  }
  if (input.scope === 'tenant' && input.tenantId === null) {
    throw new Error('knowledge_chunks: scope=tenant requires non-null tenantId');
  }
  if (input.scope === 'global' && input.tenantId !== null) {
    throw new Error('knowledge_chunks: scope=global requires null tenantId');
  }
  if (input.content.length === 0 || input.contentScrubbed.length === 0) {
    throw new Error('knowledge_chunks: content and contentScrubbed must be non-empty');
  }
}

function clampK(k: number | undefined): number {
  return Math.max(1, Math.min(MAX_K, k ?? DEFAULT_K));
}

function similarityFloor(min: number | undefined): number {
  if (min === undefined) return DEFAULT_MIN_SIMILARITY;
  return Math.max(0, Math.min(1, min));
}

// ─── Cosine helpers (used by InMemory + as a sanity check) ───────────────────

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dim mismatch ${a.length} vs ${b.length}`);
  }
  const denom = norm(a) * norm(b);
  if (denom === 0) return 0;
  return dot(a, b) / denom;
}

// ─── Pg implementation ───────────────────────────────────────────────────────

/** Format a number[] as the pgvector literal `[1.2,3.4,...]`. */
function toPgVectorLiteral(v: readonly number[]): string {
  return `[${v.join(',')}]`;
}

interface KnowledgeChunkRow {
  id: string;
  tenant_id: string | null;
  scope: KnowledgeChunkScope;
  source_type: string;
  source_id: string;
  source_version: number;
  content: string;
  content_scrubbed: string;
  embedding: string; // pgvector returns the literal as text by default
  embedding_model: string;
  chunk_schema_version: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function rowToChunk(row: KnowledgeChunkRow, embedding: number[]): KnowledgeChunk {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.scope,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    content: row.content,
    contentScrubbed: row.content_scrubbed,
    embedding,
    embeddingModel: row.embedding_model,
    chunkSchemaVersion: row.chunk_schema_version,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePgVectorLiteral(literal: string): number[] {
  // pgvector serializes as `[1,2,3]`. Trim brackets, split on commas.
  const inner = literal.startsWith('[') && literal.endsWith(']')
    ? literal.slice(1, -1)
    : literal;
  return inner.length === 0 ? [] : inner.split(',').map(Number);
}

export class PgKnowledgeChunkRepository extends PgBaseRepository implements KnowledgeChunkRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async insert(input: KnowledgeChunkInput): Promise<KnowledgeChunk> {
    validateInput(input);
    const sourceVersion = input.sourceVersion ?? 1;
    const chunkSchemaVersion = input.chunkSchemaVersion ?? 1;
    const metadata = input.metadata ?? {};
    const embeddingLiteral = toPgVectorLiteral(input.embedding);

    const exec = async (client: PoolClient): Promise<KnowledgeChunkRow> => {
      const result = await client.query<KnowledgeChunkRow>(
        `INSERT INTO knowledge_chunks (
           tenant_id, scope, source_type, source_id, source_version,
           content, content_scrubbed, embedding, embedding_model,
           chunk_schema_version, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11
         )
         ON CONFLICT (scope, source_type, source_id, source_version) DO UPDATE SET
           content              = EXCLUDED.content,
           content_scrubbed     = EXCLUDED.content_scrubbed,
           embedding            = EXCLUDED.embedding,
           embedding_model      = EXCLUDED.embedding_model,
           chunk_schema_version = EXCLUDED.chunk_schema_version,
           metadata             = EXCLUDED.metadata,
           updated_at           = NOW()
         RETURNING *`,
        [
          input.tenantId,
          input.scope,
          input.sourceType,
          input.sourceId,
          sourceVersion,
          input.content,
          input.contentScrubbed,
          embeddingLiteral,
          input.embeddingModel ?? EMBEDDING_MODEL,
          chunkSchemaVersion,
          metadata,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('knowledge_chunks: INSERT returned no row');
      return row;
    };

    // Global rows have tenant_id IS NULL; the RLS policy allows that
    // INSERT regardless of GUC (the WITH CHECK is implicit-true for
    // null tenant_id). Tenant rows must have the GUC set so the WITH
    // CHECK clause permits the row.
    const row = input.tenantId
      ? await this.withTenantTransaction(input.tenantId, exec)
      : await this.withClient(exec);

    return rowToChunk(row, input.embedding);
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    if (opts.queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `knowledge_chunks.search: embedding length ${opts.queryEmbedding.length} != ${EMBEDDING_DIMENSIONS}`,
      );
    }
    const k = clampK(opts.k);
    const minSim = similarityFloor(opts.minSimilarity);
    const maxDistance = 1 - minSim;
    const queryLiteral = toPgVectorLiteral(opts.queryEmbedding);
    const sourceTypes = opts.sourceTypes;

    return this.withTenant(opts.tenantId, async (client) => {
      const params: unknown[] = [queryLiteral, maxDistance, k];
      let sourceFilter = '';
      if (sourceTypes && sourceTypes.length > 0) {
        sourceFilter = `AND source_type = ANY($${params.length + 1}::text[])`;
        params.push(sourceTypes);
      }
      const result = await client.query<KnowledgeChunkRow & { distance: string }>(
        `SELECT *,
                (embedding <=> $1::vector) AS distance
           FROM knowledge_chunks
          WHERE (embedding <=> $1::vector) <= $2
                ${sourceFilter}
          ORDER BY embedding <=> $1::vector ASC
          LIMIT $3`,
        params,
      );
      return result.rows.map((row) => {
        const embedding = parsePgVectorLiteral(row.embedding);
        const distance = Number(row.distance);
        return {
          chunk: rowToChunk(row, embedding),
          similarity: 1 - distance,
        };
      });
    });
  }
}

// ─── In-memory implementation (for unit tests) ───────────────────────────────

export class InMemoryKnowledgeChunkRepository implements KnowledgeChunkRepository {
  private readonly rows: KnowledgeChunk[] = [];

  async insert(input: KnowledgeChunkInput): Promise<KnowledgeChunk> {
    validateInput(input);
    const sourceVersion = input.sourceVersion ?? 1;

    // Honour the (scope, source_type, source_id, source_version)
    // unique constraint by overwriting on conflict, mirroring the Pg
    // ON CONFLICT DO UPDATE behaviour.
    const existingIdx = this.rows.findIndex(
      (r) =>
        r.scope === input.scope &&
        r.sourceType === input.sourceType &&
        r.sourceId === input.sourceId &&
        r.sourceVersion === sourceVersion,
    );
    const now = new Date();
    const chunk: KnowledgeChunk = {
      id: existingIdx >= 0 ? this.rows[existingIdx].id : crypto.randomUUID(),
      tenantId: input.tenantId,
      scope: input.scope,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceVersion,
      content: input.content,
      contentScrubbed: input.contentScrubbed,
      embedding: [...input.embedding],
      embeddingModel: input.embeddingModel ?? EMBEDDING_MODEL,
      chunkSchemaVersion: input.chunkSchemaVersion ?? 1,
      metadata: { ...(input.metadata ?? {}) },
      createdAt: existingIdx >= 0 ? this.rows[existingIdx].createdAt : now,
      updatedAt: now,
    };
    if (existingIdx >= 0) this.rows[existingIdx] = chunk;
    else this.rows.push(chunk);
    return chunk;
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    if (opts.queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `InMemoryKnowledgeChunkRepository.search: embedding length ${opts.queryEmbedding.length} != ${EMBEDDING_DIMENSIONS}`,
      );
    }
    const k = clampK(opts.k);
    const minSim = similarityFloor(opts.minSimilarity);
    const sourceTypeSet = opts.sourceTypes ? new Set<string>(opts.sourceTypes) : null;

    const candidates = this.rows.filter((r) => {
      // Mirror RLS: tenant rows visible only to that tenant; global rows always visible.
      if (r.scope === 'tenant' && r.tenantId !== opts.tenantId) return false;
      if (sourceTypeSet && !sourceTypeSet.has(r.sourceType)) return false;
      return true;
    });

    const scored = candidates.map((chunk) => ({
      chunk,
      similarity: cosineSimilarity(opts.queryEmbedding, chunk.embedding),
    }));

    return scored
      .filter((hit) => hit.similarity >= minSim)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }
}
