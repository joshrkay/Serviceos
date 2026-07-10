# Phase 17 — Inbound AI: Corpus Seeder + RAG Context Integration

> **2 stories** | Activates the plumbing/HVAC knowledge base built in corpus/data/ and wires vector retrieval into every FSM turn · P17-002 already shipped

---

## Purpose

The inbound AI agent (Phase 8) is fully wired and deployed but answers only from its system prompt.  The vector infrastructure already exists — migration 062 created `knowledge_chunks` + pgvector index, `PgKnowledgeChunkRepository` can embed-and-search, and `retrieveContext` is a built skill — but nothing seeds the table and nothing calls it during a live session.

These two stories close that loop:

- **P17-001** — Seed `knowledge_chunks` from `corpus/data/vocabulary.json` and `corpus/data/triage-rules.json` so the agent has curated lay-language↔technical mappings and 4-tier triage rules as global context.
- **P17-002** ✅ — Wire `retrieveContext` into `context-builder.buildSourceContext()` behind a `RAG_RETRIEVAL_ENABLED` feature flag; inject the top-k hits as a `ragHits` section of `SourceContext` so every FSM prompt turn can ground its answer in retrieved knowledge. **Already implemented** in `packages/api/src/ai/orchestration/retrieve-adapter.ts` and updated `context-builder.ts`.

## Exit Criteria

- Running `pnpm seed:corpus` (or `ts-node corpus-seed-worker.ts`) inserts all vocabulary and triage-rule chunks into `knowledge_chunks` without duplicates (idempotent on `external_id`).
- When `RAG_RETRIEVAL_ENABLED=true`, a call to `buildSourceContext()` that includes a customer utterance returns `ragHits` populated with the top-5 most relevant knowledge chunks; the FSM system prompt includes a `## Retrieved context` section built from those hits.
- When `RAG_RETRIEVAL_ENABLED=false` (default), `buildSourceContext()` behaves identically to today — no latency, no errors.
- Every retrieval is logged to `retrieval_eval_runs` (query text, chunk ids, distances, flag state).
- `npx tsc --project packages/api/tsconfig.build.json --noEmit` passes with zero errors.

## Foundations already in place

- `packages/api/src/db/schema.ts` — migration `062_knowledge_chunks` adds `CREATE EXTENSION vector`, `knowledge_chunks` table, ivfflat index (`lists=100`, `vector_cosine_ops`), and `retrieval_eval_runs` A/B log table. No new migration needed.
- `packages/api/src/ai/training/knowledge-chunks.ts` — `PgKnowledgeChunkRepository` with `.insert()` (upsert on `external_id`) and `.search(query, opts)` (cosine distance ≤ `maxDistance`, default `k=5`). `EMBEDDING_DIMENSIONS=1536`, `EMBEDDING_MODEL='text-embedding-3-small'`.
- `packages/api/src/ai/skills/retrieve-context.ts` — `retrieveContext(input, deps)`: embeds query, calls `.search()`, returns chunks. Failure-soft (returns `[]` on error).
- `corpus/data/vocabulary.json` — Curated lay→technical term mappings: 13 fixture families (plumbing + HVAC), symptom vocabulary, fixture_parts_map, location_descriptions.
- `corpus/data/triage-rules.json` — 4-tier triage rules with trigger_words, multi_fixture_rule, seasonal_adjustments, triage_questions, and false_positive_guards.
- `packages/api/src/ai/orchestration/context-builder.ts` — updated with `RetrievedChunk` type and optional `retrieve` adapter dep; `buildSourceContext()` already injects `## Retrieved context` section when the adapter is wired.
- `packages/api/src/ai/orchestration/retrieve-adapter.ts` — `createRetrieveAdapter()` factory wiring `EmbeddingProvider` + `KnowledgeChunkRepository` + `RetrievalEvalRunRepository`; gated on `RAG_RETRIEVAL_ENABLED` in `app.ts:775`.
- `packages/api/test/ai/orchestration/context-builder.retrieve.test.ts` — 497-line test suite for the retrieval path (P17-002 tests already passing).

---

## Story Specifications

### P17-001 — Corpus seeder worker (vocabulary + triage rules → knowledge_chunks)

> **Size:** S | **Layer:** AI / Data | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** migration 062 (knowledge_chunks table, already merged)

**Allowed files:**
- `packages/api/src/workers/corpus-seed-worker.ts` (new)
- `packages/api/src/ai/training/knowledge-chunks.ts` (reference — do not modify)
- `packages/api/package.json` (add `seed:corpus` script)
- `corpus/data/vocabulary.json` (read-only input)
- `corpus/data/triage-rules.json` (read-only input)

**Build prompt:** Create `packages/api/src/workers/corpus-seed-worker.ts`. The worker reads `corpus/data/vocabulary.json` and `corpus/data/triage-rules.json` from disk (resolve paths relative to the repo root using `path.resolve(__dirname, '../../../../corpus/data/')`), converts them to `KnowledgeChunk` insert payloads, and upserts into `knowledge_chunks` via `PgKnowledgeChunkRepository.insert()`.

Chunking strategy:

**From vocabulary.json:**
- One chunk per fixture family (e.g. `under_sink_supply`, `furnace`): concatenate the `lay_terms`, `technical_terms`, and `symptom_vocabulary` arrays into a single prose sentence: `"Customer may say: {lay_terms}. Technical terms: {technical_terms}. Common symptoms: {sounds/sight/smell/touch entries}."` Set `source_type='vertical_terminology'`, `scope='global'`, `category` = `'plumbing'` or `'hvac'` based on fixture family.
- One chunk per `fixture_parts_map` entry (e.g. `toilet.flapper`): `"Toilet flapper complaints: {complaint list}. Likely cause: {likely_cause}."` — `source_type='vertical_terminology'`.
- One chunk per `common_misidentifications` entry: `"Customers often confuse {term} — {explanation}."` — `source_type='vertical_terminology'`.

**From triage-rules.json:**
- One chunk per tier in `trigger_words`: `"TIER_1_EVACUATE triggers (life-safety): {phrase list}. Dispatch protocol: immediate evacuation + emergency services."` — `source_type='vertical_category'`, `category='hvac'` for CO/gas tiers, `'plumbing'` for flooding tiers, `'general'` otherwise.
- One chunk for `multi_fixture_rule`: prose description of the multiple-drains → main-line reclassification logic.
- One chunk per `triage_questions` category block (plumbing / hvac): full question list as prose.
- One chunk per `false_positive_guards` entry: `"False positive guard — {condition}: {explanation}."` — `source_type='vertical_category'`.

All chunks:
- `external_id` = deterministic hash of `source_type + ':' + fixture_or_key` so re-runs are idempotent.
- `content_scrubbed` = the prose text (no PII possible — all static data).
- `embedding` = call `EmbeddingProvider.createEmbedding(content_scrubbed)` from `packages/api/src/ai/gateway/embedding-provider.ts`.
- `tenant_id` = `null` (global scope).

Wrap the embed+insert loop in `p-limit` with concurrency=5 to avoid rate-limiting. Log progress to stdout. Export a `seedCorpus(db, embeddingProvider)` function and a `main()` entry point that builds its own DB + provider instances from env. Add a `"seed:corpus": "ts-node src/workers/corpus-seed-worker.ts"` script to `packages/api/package.json`.

**Review prompt:** Verify external_id derivation is deterministic and collision-free across all chunk types. Verify `scope='global'` and `tenant_id=null` on every inserted row. Verify the upsert (conflict on `external_id`) is idempotent — running twice inserts the same count the first time and 0 new rows the second. Verify concurrency=5 p-limit doesn't cause out-of-order inserts. Verify no PII can reach `content_scrubbed` (static data only).

**Automated checks:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P17-001|corpus-seed"
```

**Required tests:**
- [ ] `chunkVocabulary(vocabulary)` returns at least one chunk per fixture family
- [ ] `chunkTriageRules(rules)` returns at least one chunk per tier + false-positive guards
- [ ] All chunks have `scope='global'` and `tenant_id=null`
- [ ] `external_id` is deterministic: calling chunker twice on same input produces identical ids
- [ ] Idempotency: seeding twice on a mocked repo calls `.insert()` with identical rows; repo upsert absorbs duplicates without error

---

### P17-002 — RAG context integration (retrieveContext → buildSourceContext → FSM prompt) ✅ SHIPPED

> **Size:** M | **Layer:** AI / Orchestration | **AI Build:** High | **Human Review:** Moderate

**Dependencies:** P17-001 (knowledge_chunks populated), P8-001 (FSM + context-builder)

**Allowed files:**
- `packages/api/src/ai/orchestration/context-builder.ts`
- `packages/api/src/ai/context/source-context.ts` (add `ragHits` field)
- `packages/api/src/shared/config.ts` (add `RAG_RETRIEVAL_ENABLED` flag)
- `packages/api/src/ai/training/retrieval-eval-run.ts` (new — `PgRetrievalEvalRunRepository`)
- `packages/api/test/ai/orchestration/context-builder.test.ts`

**Build prompt:** Wire `retrieveContext` into the FSM prompt pipeline behind an env flag.

**Step 1 — Config flag.** In `packages/api/src/shared/config.ts`, add:
```ts
ragRetrievalEnabled: process.env.RAG_RETRIEVAL_ENABLED === 'true',
```
No entry in `validateProductionConfig()` — the flag is optional (defaults off).

**Step 2 — SourceContext type.** In `packages/api/src/ai/context/source-context.ts`, add an optional field:
```ts
ragHits?: Array<{ chunkId: string; content: string; similarity: number; sourceType: string }>;
```

**Step 3 — Retrieval eval run repository.** Create `packages/api/src/ai/training/retrieval-eval-run.ts`:
```ts
export interface RetrievalEvalRun {
  id: string;
  sessionId: string;
  query: string;
  chunkIds: string[];
  distances: number[];
  flagEnabled: boolean;
  createdAt: Date;
}
export class PgRetrievalEvalRunRepository {
  constructor(private db: Pool) {}
  async log(run: Omit<RetrievalEvalRun, 'id' | 'createdAt'>): Promise<void> {
    await this.db.query(
      `INSERT INTO retrieval_eval_runs (session_id, query, chunk_ids, distances, flag_enabled)
       VALUES ($1, $2, $3, $4, $5)`,
      [run.sessionId, run.query, run.chunkIds, run.distances, run.flagEnabled]
    );
  }
}
```

**Step 4 — context-builder wiring.** In `buildSourceContext()`:
1. Accept new optional deps: `knowledgeRepo?: PgKnowledgeChunkRepository`, `evalRunRepo?: PgRetrievalEvalRunRepository`, `config?: { ragRetrievalEnabled: boolean }`.
2. Derive a retrieval query from the last customer utterance in the message window (last message where `role === 'user'`).
3. If `config.ragRetrievalEnabled && knowledgeRepo && query`:
   - Call `retrieveContext({ query, k: 5, maxDistance: 0.25 }, { knowledgeRepo })`.
   - Map results to `ragHits` array on the returned `SourceContext`.
   - Log to `evalRunRepo.log(...)` (fire-and-forget — do not await, do not throw).
4. If `ragHits` is populated, append a `## Retrieved context` section to the assembled prompt string (placed after `## Vertical config` and before the token trim):
   ```
   ## Retrieved context
   {ragHits.map(h => `[${h.sourceType}] ${h.content}`).join('\n\n')}
   ```
5. The 8,000-token trim already at end of `buildSourceContext()` naturally handles oversized RAG sections — no additional truncation logic needed.
6. When flag is off, `ragHits` is `undefined` and the section is omitted — behavior is identical to today.

**Review prompt:** Verify `RAG_RETRIEVAL_ENABLED=false` (default) produces zero extra latency and identical output to the current implementation. Verify `RAG_RETRIEVAL_ENABLED=true` with an empty `knowledge_chunks` table returns `ragHits=[]` without error. Verify the eval run log is fire-and-forget (a log failure must not throw or stall the prompt build). Verify the `## Retrieved context` section appears in the assembled prompt only when `ragHits.length > 0`. Verify no customer PII leaks into `query` after `scrubPii()` is applied before the embed call.

**Automated checks:**
```bash
cd /home/user/Serviceos && \
  npx tsc --project packages/api/tsconfig.build.json --noEmit && \
  npm test --workspace=packages/api -- --run --grep "P17-002|context-builder|ragHits"
```

**Required tests:**
- [ ] Flag off → `buildSourceContext()` output is byte-identical to baseline (no `ragHits`, no `## Retrieved context`)
- [ ] Flag on, `knowledgeRepo` returns 3 hits → `ragHits` has 3 entries, `## Retrieved context` section present in assembled prompt
- [ ] Flag on, `knowledgeRepo` returns empty → `ragHits=[]`, section omitted, no error
- [ ] Eval run logger throws → `buildSourceContext()` still returns successfully (fire-and-forget verified)
- [ ] Customer utterance with mock PII → `scrubPii()` applied before embed; raw PII not present in logged query
- [ ] Token trim: when RAG section pushes prompt over 8,000 tokens, output is still ≤ 8,000 tokens
