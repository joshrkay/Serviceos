/**
 * Postgres integration — `knowledge_chunks` retrieval stays inside the asking
 * tenant (plus the global tier) through the PRODUCTION repository.
 *
 * `PgKnowledgeChunkRepository.search` is the RAG retrieval behind every AI
 * turn that pulls context. Its SQL used to carry no tenant predicate at all,
 * so isolation rested entirely on the `tenant_isolation_knowledge_chunks`
 * policy — which only enforces once `RLS_RUNTIME_ROLE=true` drops the client
 * into `rls_app_runtime`. Anywhere the flag is unset (dev, a misconfigured
 * non-prod deploy) tenant B's turn retrieved tenant A's chunks.
 *
 * The same holds for ingestion. `insert` upserts on its dedupe key, and that
 * key used to be `(scope, source_type, source_id, source_version)` with no
 * `tenant_id`: a second tenant writing a colliding source tuple either
 * overwrote the first tenant's content and embedding (policy inert) or failed
 * the RLS check (policy on). The key is now tenant-aware (migration 351).
 * This file runs on a fresh database, which only has that key, so a colliding
 * tuple gets its own row. A database that ran 062's original body keeps the
 * tenant-blind key too until 351's contract migration, and there the second
 * tenant's insert is refused instead: knowledge-chunks-dedupe-expand-contract.test.ts.
 *
 * Both flag states are pinned: ON proves the policy and the SQL agree, OFF
 * proves the SQL alone bounds the read and the write (the defense-in-depth
 * backstop). A mocked Pool can prove neither — the vector operator, the
 * unique index, the policy and the runtime role only exist in real Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  PgKnowledgeChunkRepository,
  type KnowledgeChunkInput,
} from '../../src/ai/training/knowledge-chunks';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

let pool: Pool;
let repo: PgKnowledgeChunkRepository;
const createdTenantIds: string[] = [];
const createdSourceIds: string[] = [];

/**
 * One direction shared by every row this file writes, so cosine similarity is
 * exactly 1 and ranking never decides whether a row is in the result.
 */
const VECTOR = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 7 ? 1 : 0));
const VECTOR_LITERAL = `[${VECTOR.join(',')}]`;
// A source type no other suite writes, so this file's rows are the only hits.
const SOURCE_TYPE = 'vertical_eval_scenario' as const;

async function seedChunk(tenantId: string | null): Promise<string> {
  const sourceId = `kc-iso-${crypto.randomUUID()}`;
  createdSourceIds.push(sourceId);
  // Seeded as the superuser pool (bypasses RLS) — correct for fixture setup.
  await pool.query(
    `INSERT INTO knowledge_chunks
       (tenant_id, scope, source_type, source_id, content, content_scrubbed, embedding, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $5, $6::vector, $7)`,
    [
      tenantId,
      tenantId ? 'tenant' : 'global',
      SOURCE_TYPE,
      sourceId,
      `content ${sourceId}`,
      VECTOR_LITERAL,
      EMBEDDING_MODEL,
    ],
  );
  return sourceId;
}

async function seedTenant(): Promise<string> {
  const { tenantId } = await createTestTenant(pool);
  createdTenantIds.push(tenantId);
  return tenantId;
}

async function searchSourceIds(tenantId: string): Promise<string[]> {
  const hits = await repo.search({
    tenantId,
    queryEmbedding: VECTOR,
    sourceTypes: [SOURCE_TYPE],
    k: 50,
    minSimilarity: 0,
  });
  return hits.map((h) => h.chunk.sourceId);
}

beforeAll(async () => {
  pool = await getSharedTestDb();
  repo = new PgKnowledgeChunkRepository(pool);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  await pool
    .query('DELETE FROM knowledge_chunks WHERE source_id = ANY($1::text[])', [createdSourceIds])
    .catch(() => undefined);
  for (const tenantId of createdTenantIds) {
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('PgKnowledgeChunkRepository.search — tenant-bounded retrieval (real Postgres)', () => {
  for (const flag of ['true', undefined] as const) {
    const label = flag ? 'RLS_RUNTIME_ROLE=true' : 'RLS_RUNTIME_ROLE unset (policy inert)';

    it(`${label}: returns the asking tenant's chunks and the global tier, never another tenant's`, async () => {
      if (flag) process.env.RLS_RUNTIME_ROLE = flag;
      else delete process.env.RLS_RUNTIME_ROLE;

      const tenantA = await seedTenant();
      const tenantB = await seedTenant();
      const chunkA = await seedChunk(tenantA);
      const chunkB = await seedChunk(tenantB);
      const chunkGlobal = await seedChunk(null);

      const seenByB = await searchSourceIds(tenantB);
      // Own tenant + global still retrieved: the bound did not break retrieval.
      expect(seenByB).toContain(chunkB);
      expect(seenByB).toContain(chunkGlobal);
      // Another tenant's chunk is never retrieved, policy or no policy.
      expect(seenByB).not.toContain(chunkA);

      const seenByA = await searchSourceIds(tenantA);
      expect(seenByA).toContain(chunkA);
      expect(seenByA).toContain(chunkGlobal);
      expect(seenByA).not.toContain(chunkB);
    });
  }
});

function chunkInput(tenantId: string | null, sourceId: string, content: string): KnowledgeChunkInput {
  return {
    tenantId,
    scope: tenantId ? 'tenant' : 'global',
    sourceType: SOURCE_TYPE,
    sourceId,
    content,
    contentScrubbed: content,
    embedding: VECTOR,
  };
}

async function rowsForSource(sourceId: string): Promise<Array<{ id: string; tenant_id: string | null; content: string }>> {
  const { rows } = await pool.query<{ id: string; tenant_id: string | null; content: string }>(
    'SELECT id, tenant_id, content FROM knowledge_chunks WHERE source_id = $1 ORDER BY created_at',
    [sourceId],
  );
  return rows;
}

describe('PgKnowledgeChunkRepository.insert — tenant-aware dedupe key (real Postgres)', () => {
  for (const flag of ['true', undefined] as const) {
    const label = flag ? 'RLS_RUNTIME_ROLE=true' : 'RLS_RUNTIME_ROLE unset (policy inert)';

    it(`${label}: a colliding source tuple from another tenant gets its own row and never touches the first tenant's`, async () => {
      if (flag) process.env.RLS_RUNTIME_ROLE = flag;
      else delete process.env.RLS_RUNTIME_ROLE;

      const tenantA = await seedTenant();
      const tenantB = await seedTenant();
      const sourceId = `kc-dedupe-${crypto.randomUUID()}`;
      createdSourceIds.push(sourceId);

      const a = await repo.insert(chunkInput(tenantA, sourceId, 'tenant A content'));
      const b = await repo.insert(chunkInput(tenantB, sourceId, 'tenant B content'));

      expect(b.id).not.toBe(a.id);
      expect(b.tenantId).toBe(tenantB);
      const rows = await rowsForSource(sourceId);
      expect(rows.map((r) => [r.tenant_id, r.content])).toEqual([
        [tenantA, 'tenant A content'],
        [tenantB, 'tenant B content'],
      ]);

      // Each tenant retrieves its own copy only.
      const seenByA = await repo.search({ tenantId: tenantA, queryEmbedding: VECTOR, sourceTypes: [SOURCE_TYPE], k: 50, minSimilarity: 0 });
      expect(seenByA.filter((h) => h.chunk.sourceId === sourceId).map((h) => h.chunk.content)).toEqual(['tenant A content']);
      const seenByB = await repo.search({ tenantId: tenantB, queryEmbedding: VECTOR, sourceTypes: [SOURCE_TYPE], k: 50, minSimilarity: 0 });
      expect(seenByB.filter((h) => h.chunk.sourceId === sourceId).map((h) => h.chunk.content)).toEqual(['tenant B content']);
    });

    it(`${label}: re-ingesting the same tuple for the same tenant still upserts in place`, async () => {
      if (flag) process.env.RLS_RUNTIME_ROLE = flag;
      else delete process.env.RLS_RUNTIME_ROLE;

      const tenantA = await seedTenant();
      const sourceId = `kc-reingest-${crypto.randomUUID()}`;
      createdSourceIds.push(sourceId);

      const first = await repo.insert(chunkInput(tenantA, sourceId, 'first'));
      const second = await repo.insert(chunkInput(tenantA, sourceId, 'second'));

      expect(second.id).toBe(first.id);
      expect((await rowsForSource(sourceId)).map((r) => r.content)).toEqual(['second']);
    });

    it(`${label}: re-ingesting the same global tuple still upserts in place (NULL tenant ids collide)`, async () => {
      if (flag) process.env.RLS_RUNTIME_ROLE = flag;
      else delete process.env.RLS_RUNTIME_ROLE;

      const sourceId = `kc-global-${crypto.randomUUID()}`;
      createdSourceIds.push(sourceId);

      const first = await repo.insert(chunkInput(null, sourceId, 'global first'));
      const second = await repo.insert(chunkInput(null, sourceId, 'global second'));

      expect(second.id).toBe(first.id);
      const rows = await rowsForSource(sourceId);
      expect(rows.map((r) => [r.tenant_id, r.content])).toEqual([[null, 'global second']]);
    });
  }
});
