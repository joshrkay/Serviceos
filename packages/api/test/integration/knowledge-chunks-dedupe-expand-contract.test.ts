/**
 * Postgres integration — migration 351 only ADDS the tenant-aware
 * knowledge-chunk dedupe key, so the release carrying it can roll out, replay
 * and roll back while the previous release's code is still writing chunks.
 *
 * The web service's preDeployCommand runs the corpus while the old web replica
 * keeps serving (overlapSeconds 35). The worker service (railway.worker.toml)
 * deploys after web, so it runs the previous release against the migrated
 * schema for longer still, and the two knowledge-chunk writers
 * (transcript-ingestion and proposal-correction workers) run there. The
 * previous release's insert names ON CONFLICT (scope, source_type, source_id,
 * source_version). If 351 dropped 062's index on those columns, every such
 * insert would fail 42P10, and both workers log and drop a failed insert, so
 * those chunks would be lost.
 *
 * So 351 creates (tenant_id, scope, source_type, source_id, source_version)
 * NULLS NOT DISTINCT beside 062's index and drops nothing. A later release
 * drops 062's index once this one has fully rolled out on web and worker
 * (contract). While both exist, this release's insert of a tuple another
 * tenant holds is refused by 062's index: the other tenant's row is left alone
 * and the insert throws KnowledgeChunkDedupeCollisionError.
 *
 * 351 first shipped (#1813) with a DROP of 062's index, and dev auto-deploys
 * main, so a database can be in either state when this release's corpus
 * replays over it:
 *   (a) production: it ran the previous release's corpus and never the drop,
 *       so it keeps 062's index;
 *   (b) dev: it ran #1813's 351, so 062's index is gone and two tenants may
 *       already share a tuple. Nothing may try to rebuild 062's index there.
 *
 * Every other integration suite starts from a fresh database, which never ran
 * 062's original body and so never has the tenant-blind index. This file
 * builds both real histories on dedicated databases.
 */
import { createHash } from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { applyMigrations } from '../../src/db/migrate';
import { MIGRATIONS, compileMigrationSQL } from '../../src/db/schema';
import { applyTenantContext, clearTenantContext } from '../../src/db/rls-runtime-role';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  KnowledgeChunkDedupeCollisionError,
  PgKnowledgeChunkRepository,
  type KnowledgeChunkInput,
} from '../../src/ai/training/knowledge-chunks';
import { knowledgeChunkDedupeCollisionsTotal } from '../../src/monitoring/metrics';
import { createTestTenant, ensureRlsRuntimeRole } from './shared';

// ─── Earlier releases' corpora ───────────────────────────────────────────────

/** 062's body as main shipped it before #1813, which every production database ran. */
const PREVIOUS_062 = `
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id            UUID NULL REFERENCES tenants(id) ON DELETE CASCADE,
      scope                TEXT NOT NULL CHECK (scope IN ('tenant', 'global')),
      source_type          TEXT NOT NULL,
      source_id            TEXT NOT NULL,
      source_version       INTEGER NOT NULL DEFAULT 1,
      content              TEXT NOT NULL,
      content_scrubbed     TEXT NOT NULL,
      embedding            vector(1536) NOT NULL,
      embedding_model      TEXT NOT NULL CHECK (embedding_model = 'text-embedding-3-small'),
      chunk_schema_version INTEGER NOT NULL DEFAULT 1,
      metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (scope = 'tenant' AND tenant_id IS NOT NULL)
        OR (scope = 'global' AND tenant_id IS NULL)
      )
    );

    -- Approximate-nearest-neighbour index for cosine similarity. Defaults to
    -- 100 lists, suitable for tens of thousands to ~1M rows; revisit when a
    -- single tenant crosses ~10M chunks.
    CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_ivfflat
      ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);

    CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant_source
      ON knowledge_chunks (tenant_id, source_type, source_id);

    -- Idempotent ingestion: same (scope, source_type, source_id, version)
    -- collides cleanly so re-ingestion with ON CONFLICT works.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunks_dedupe
      ON knowledge_chunks (scope, source_type, source_id, source_version);

    ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation_knowledge_chunks ON knowledge_chunks;
    CREATE POLICY tenant_isolation_knowledge_chunks ON knowledge_chunks
      USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id')::UUID);
  `;
/** The hash migration-immutability.test.ts carried for 062 before #1813 edited it. */
const PREVIOUS_062_SHA256 = '047b45413e633e21dacadbb400c6830b556377829b761107d24da6bf080bd13d';
const PREVIOUS_RELEASE_LAST_KEY = '350_drip_membership_renewals';

/** 351's body as #1813 merged it (dev ran it): it dropped 062's index. */
const MERGED_351 = `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant_dedupe
      ON knowledge_chunks (tenant_id, scope, source_type, source_id, source_version)
      NULLS NOT DISTINCT;
    DROP INDEX IF EXISTS idx_knowledge_chunks_dedupe;
  `;
/** The hash migration-immutability.test.ts carried for 351 as #1813 merged it. */
const MERGED_351_SHA256 = 'e70fec7cec3c9abfb58bb4a88bec25ea2e8c98211628350273aa0d53d72d2181';

function pinned(label: string, body: string, sha256: string): string {
  const hash = createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex');
  if (hash !== sha256) throw new Error(`${label} is not the shipped body (sha256 ${hash})`);
  return body;
}

/**
 * The previous release's corpus: every key through 350, with 062 as shipped.
 * Every other body through 350 is byte-identical to that release's (the
 * immutability snapshot pins each one).
 */
function previousReleaseMigrations(): Record<string, string> {
  const previous062 = pinned('PREVIOUS_062', PREVIOUS_062, PREVIOUS_062_SHA256);
  const keys = Object.keys(MIGRATIONS);
  const last = keys.indexOf(PREVIOUS_RELEASE_LAST_KEY);
  if (last < 0) throw new Error(`${PREVIOUS_RELEASE_LAST_KEY} is not in MIGRATIONS`);
  const live = MIGRATIONS as Record<string, string>;
  return Object.fromEntries(
    keys.slice(0, last + 1).map((k) => [k, k === '062_create_knowledge_chunks' ? previous062 : live[k]]),
  );
}

/** The corpus #1813 merged to main: this release's, with 351 as #1813 shipped it. */
function mergedReleaseMigrations(): Record<string, string> {
  const merged351 = pinned('MERGED_351', MERGED_351, MERGED_351_SHA256);
  const live = MIGRATIONS as Record<string, string>;
  return Object.fromEntries(
    Object.keys(live).map((k) => [k, k === '351_knowledge_chunks_tenant_dedupe' ? merged351 : live[k]]),
  );
}

/** PgKnowledgeChunkRepository.insert's statement in the previous release, verbatim. */
const PREVIOUS_RELEASE_INSERT = `INSERT INTO knowledge_chunks (
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
         RETURNING *`;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SOURCE_TYPE = 'call_summary' as const;
const VECTOR = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 7 ? 1 : 0));
const VECTOR_LITERAL = `[${VECTOR.join(',')}]`;
const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

function newSourceId(label: string): string {
  return `kc-${label}-${crypto.randomUUID()}`;
}

/** A dedicated database: each scenario needs its own migration history. */
class ScenarioDb {
  readonly name = `kc_expand_${crypto.randomUUID().replace(/-/g, '')}`;
  private admin: Pool | undefined;
  pool!: Pool;

  async create(): Promise<void> {
    const baseUri = process.env.TEST_DB_URL;
    if (!baseUri) throw new Error('TEST_DB_URL not set — run via the integration config');
    this.admin = new Pool({ connectionString: baseUri, max: 1 });
    await this.admin.query(`CREATE DATABASE ${this.name}`);
    const uri = new URL(baseUri);
    uri.pathname = `/${this.name}`;
    this.pool = new Pool({ connectionString: uri.toString(), max: 4 });
  }

  async drop(): Promise<void> {
    // pool.end() resolves before its idle sockets have closed, so DROP ... WITH
    // (FORCE) can terminate one first, and the pool re-emits that 57P01 as an
    // 'error' event. Teardown only: nothing reads this pool afterwards.
    this.pool?.on('error', () => undefined);
    await this.pool?.end();
    if (this.admin) {
      await this.admin.query(`DROP DATABASE IF EXISTS ${this.name} WITH (FORCE)`);
      await this.admin.end();
    }
  }

  /** One deploy of an earlier release: its corpus, with the runner's session settings. */
  async deployCorpus(migrations: Record<string, string>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SET lock_timeout = '5s'");
      await client.query("SET statement_timeout = '25s'");
      await client.query(compileMigrationSQL(migrations));
    } finally {
      await client.query('RESET ALL').catch(() => undefined);
      client.release();
    }
  }

  /** One deploy of this release: the exact entrypoint its preDeployCommand runs. */
  async deployThisRelease(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await applyMigrations(client, { maxAttempts: 1 });
    } finally {
      await client.query('RESET ALL').catch(() => undefined);
      client.release();
    }
  }

  /**
   * The previous release's PgKnowledgeChunkRepository.insert: a tenant row in
   * its own tenant transaction (withTenantTransaction), a global row on a
   * plain client (withClient).
   */
  async previousReleaseInsert(tenantId: string | null, sourceId: string, content: string): Promise<{ id: string }> {
    const params = [
      tenantId,
      tenantId ? 'tenant' : 'global',
      SOURCE_TYPE,
      sourceId,
      1,
      content,
      content,
      VECTOR_LITERAL,
      EMBEDDING_MODEL,
      1,
      {},
    ];
    const client = await this.pool.connect();
    try {
      if (!tenantId) return (await client.query<{ id: string }>(PREVIOUS_RELEASE_INSERT, params)).rows[0];
      await client.query('BEGIN');
      try {
        await applyTenantContext(client, tenantId, { transactional: true });
        const { rows } = await client.query<{ id: string }>(PREVIOUS_RELEASE_INSERT, params);
        await client.query('COMMIT');
        return rows[0];
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    } finally {
      await clearTenantContext(client);
      client.release();
    }
  }

  async rowsFor(sourceId: string): Promise<StoredChunk[]> {
    const { rows } = await this.pool.query<StoredChunk>(
      `SELECT id, tenant_id, content, content_scrubbed, embedding::text AS embedding, metadata, updated_at
         FROM knowledge_chunks WHERE source_id = $1 ORDER BY created_at, id`,
      [sourceId],
    );
    return rows;
  }

  /** knowledge_chunks' unique keys, with OIDs so a rebuild shows up as a change. */
  async dedupeKeys(): Promise<DedupeKey[]> {
    const { rows } = await this.pool.query<DedupeKey>(
      `SELECT i.relname AS name, i.oid::text AS oid, pg_get_indexdef(i.oid) AS def, x.indisvalid AS valid
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
        WHERE x.indrelid = 'knowledge_chunks'::regclass AND x.indisunique AND NOT x.indisprimary
        ORDER BY i.relname`,
    );
    return rows;
  }

  async rowCount(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_chunks');
    return rows[0].n;
  }
}

interface StoredChunk {
  id: string;
  tenant_id: string | null;
  content: string;
  content_scrubbed: string;
  embedding: string;
  metadata: Record<string, unknown>;
  updated_at: Date;
}

interface DedupeKey {
  name: string;
  oid: string;
  def: string;
  valid: boolean;
}

const TENANT_BLIND_KEY = {
  name: 'idx_knowledge_chunks_dedupe',
  def: 'CREATE UNIQUE INDEX idx_knowledge_chunks_dedupe ON public.knowledge_chunks USING btree (scope, source_type, source_id, source_version)',
  valid: true,
};
const TENANT_AWARE_KEY = {
  name: 'idx_knowledge_chunks_tenant_dedupe',
  def:
    'CREATE UNIQUE INDEX idx_knowledge_chunks_tenant_dedupe ON public.knowledge_chunks USING btree ' +
    '(tenant_id, scope, source_type, source_id, source_version) NULLS NOT DISTINCT',
  valid: true,
};

function shape(keys: DedupeKey[]): Array<Omit<DedupeKey, 'oid'>> {
  return keys.map(({ name, def, valid }) => ({ name, def, valid }));
}

function chunk(tenantId: string | null, sourceId: string, content: string): KnowledgeChunkInput {
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

async function collisionCount(): Promise<number> {
  const metric = await knowledgeChunkDedupeCollisionsTotal.get();
  return metric.values.find((v) => v.labels.source_type === SOURCE_TYPE)?.value ?? 0;
}

function restoreFlag(): void {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
}

afterEach(restoreFlag);

// ─── (a) Production: the previous release's database ─────────────────────────

describe('351 expand over a database the previous release migrated (production)', () => {
  const db = new ScenarioDb();
  let repo: PgKnowledgeChunkRepository;
  let tenantA: string;
  let tenantB: string;
  /** A tenant-A tuple and a global tuple the previous release wrote before this release migrated. */
  let heldByA: string;
  let heldGlobally: string;

  beforeAll(async () => {
    await db.create();
    repo = new PgKnowledgeChunkRepository(db.pool);

    // Production today: the previous release's corpus, then its ingestion traffic.
    await db.deployCorpus(previousReleaseMigrations());
    await ensureRlsRuntimeRole(db.pool);
    tenantA = (await createTestTenant(db.pool)).tenantId;
    tenantB = (await createTestTenant(db.pool)).tenantId;
    heldByA = newSourceId('held-by-a');
    heldGlobally = newSourceId('held-globally');
    await db.previousReleaseInsert(tenantA, heldByA, 'tenant A, previous release');
    await db.previousReleaseInsert(null, heldGlobally, 'global, previous release');

    // This release's preDeployCommand. The old web replica is still serving and
    // the worker service has not redeployed yet.
    await db.deployThisRelease();
  });

  afterAll(async () => {
    restoreFlag();
    await db.drop();
  });

  it('this release migrates to both keys: 062 tenant-blind and 351 tenant-aware', async () => {
    expect(shape(await db.dedupeKeys())).toEqual([TENANT_BLIND_KEY, TENANT_AWARE_KEY]);
  });

  it('the previous release, still running after this release migrated, keeps upserting (rolling deploy)', async () => {
    const [before] = await db.rowsFor(heldByA);

    const updated = await db.previousReleaseInsert(tenantA, heldByA, 'tenant A, previous release, again');
    expect(updated.id).toBe(before.id);
    expect((await db.rowsFor(heldByA)).map((r) => [r.id, r.tenant_id, r.content])).toEqual([
      [before.id, tenantA, 'tenant A, previous release, again'],
    ]);

    const fresh = newSourceId('previous-release-new');
    await db.previousReleaseInsert(tenantA, fresh, 'new tuple from the previous release');
    expect((await db.rowsFor(fresh)).map((r) => [r.tenant_id, r.content])).toEqual([
      [tenantA, 'new tuple from the previous release'],
    ]);

    const [globalBefore] = await db.rowsFor(heldGlobally);
    const globalAgain = await db.previousReleaseInsert(null, heldGlobally, 'global, previous release, again');
    expect(globalAgain.id).toBe(globalBefore.id);
  });

  it("this release's insert dedupes per tenant, including onto rows the previous release wrote", async () => {
    const [heldRow] = await db.rowsFor(heldByA);
    const onHeld = await repo.insert(chunk(tenantA, heldByA, 'tenant A, this release'));
    expect(onHeld.id).toBe(heldRow.id);

    const sourceId = newSourceId('this-release');
    const first = await repo.insert(chunk(tenantA, sourceId, 'first'));
    const second = await repo.insert(chunk(tenantA, sourceId, 'second'));
    expect(second.id).toBe(first.id);
    expect((await db.rowsFor(sourceId)).map((r) => [r.tenant_id, r.content])).toEqual([[tenantA, 'second']]);

    const [globalRow] = await db.rowsFor(heldGlobally);
    const onGlobal = await repo.insert(chunk(null, heldGlobally, 'global, this release'));
    expect(onGlobal.id).toBe(globalRow.id);
    expect((await db.rowsFor(heldGlobally)).map((r) => [r.tenant_id, r.content])).toEqual([
      [null, 'global, this release'],
    ]);
  });

  for (const flag of ['true', undefined] as const) {
    const label = flag ? 'RLS_RUNTIME_ROLE=true' : 'RLS_RUNTIME_ROLE unset (policy inert)';

    it(`${label}: a tuple tenant A holds is refused for tenant B as a counted collision, and A's row is untouched`, async () => {
      if (flag) process.env.RLS_RUNTIME_ROLE = flag;
      else delete process.env.RLS_RUNTIME_ROLE;

      const sourceId = newSourceId('collision');
      await repo.insert(chunk(tenantA, sourceId, 'tenant A content'));
      const before = await db.rowsFor(sourceId);
      const countBefore = await collisionCount();

      const outcome = await repo.insert(chunk(tenantB, sourceId, 'tenant B content')).then(
        () => 'written',
        (err: unknown) => err,
      );

      expect(outcome).toBeInstanceOf(KnowledgeChunkDedupeCollisionError);
      expect(outcome).toMatchObject({ sourceType: SOURCE_TYPE, sourceId, sourceVersion: 1 });
      // Tenant A's row is exactly what it was, and tenant B has none.
      expect(await db.rowsFor(sourceId)).toEqual(before);
      expect(await collisionCount()).toBe(countBefore + 1);

      const seenByA = await repo.search({ tenantId: tenantA, queryEmbedding: VECTOR, sourceTypes: [SOURCE_TYPE], k: 50, minSimilarity: 0 });
      expect(seenByA.filter((h) => h.chunk.sourceId === sourceId).map((h) => h.chunk.content)).toEqual(['tenant A content']);
      const seenByB = await repo.search({ tenantId: tenantB, queryEmbedding: VECTOR, sourceTypes: [SOURCE_TYPE], k: 50, minSimilarity: 0 });
      expect(seenByB.filter((h) => h.chunk.sourceId === sourceId)).toEqual([]);
    });
  }

  it('the next deploy replays over the populated database without rebuilding or dropping either key', async () => {
    const keysBefore = await db.dedupeKeys();
    const countBefore = await db.rowCount();

    await expect(db.deployThisRelease()).resolves.toBeUndefined();

    // Same OIDs: neither index was rebuilt over live data, and neither was dropped.
    expect(await db.dedupeKeys()).toEqual(keysBefore);
    expect(shape(keysBefore)).toEqual([TENANT_BLIND_KEY, TENANT_AWARE_KEY]);
    expect(await db.rowCount()).toBe(countBefore);
  });

  it('rolling back to the previous release after this release ran succeeds, and its insert still upserts', async () => {
    // Traffic on this release before the rollback: tenant B tries a tuple tenant A holds.
    const contested = newSourceId('contested');
    await repo.insert(chunk(tenantA, contested, 'tenant A content'));
    await repo.insert(chunk(tenantB, contested, 'tenant B content')).catch((err: unknown) => {
      if (!(err instanceof KnowledgeChunkDedupeCollisionError)) throw err;
    });
    const keysBefore = await db.dedupeKeys();

    // The rollback deploy runs the previous release's preDeployCommand.
    await expect(db.deployCorpus(previousReleaseMigrations())).resolves.toBeUndefined();
    // It neither builds nor drops a key here, so rolling forward again is a no-op too.
    expect(await db.dedupeKeys()).toEqual(keysBefore);

    const [held] = await db.rowsFor(heldByA);
    const again = await db.previousReleaseInsert(tenantA, heldByA, 'tenant A, after rollback');
    expect(again.id).toBe(held.id);
    const fresh = newSourceId('after-rollback');
    await db.previousReleaseInsert(tenantB, fresh, 'tenant B, after rollback');
    expect((await db.rowsFor(fresh)).map((r) => [r.tenant_id, r.content])).toEqual([[tenantB, 'tenant B, after rollback']]);

    // Roll forward again.
    await expect(db.deployThisRelease()).resolves.toBeUndefined();
    expect(await db.dedupeKeys()).toEqual(keysBefore);
    const forward = await repo.insert(chunk(tenantB, fresh, 'tenant B, rolled forward'));
    expect((await db.rowsFor(fresh)).map((r) => [r.id, r.content])).toEqual([[forward.id, 'tenant B, rolled forward']]);
  });
});

// ─── (b) Dev: a database that already ran #1813's 351 ─────────────────────────

describe("351 expand over a database that already ran #1813's drop (dev)", () => {
  const db = new ScenarioDb();
  let repo: PgKnowledgeChunkRepository;
  let tenantA: string;
  let tenantB: string;
  /** A tuple the previous release wrote for tenant A, which tenant B then also ingested. */
  let sharedSinceDrop: string;
  /** A tuple both tenants first ingested after the drop. */
  let sharedFromStart: string;
  let rowsBefore: Map<string, StoredChunk[]>;

  beforeAll(async () => {
    await db.create();
    repo = new PgKnowledgeChunkRepository(db.pool);

    // The previous release's corpus and traffic, as everywhere...
    await db.deployCorpus(previousReleaseMigrations());
    await ensureRlsRuntimeRole(db.pool);
    tenantA = (await createTestTenant(db.pool)).tenantId;
    tenantB = (await createTestTenant(db.pool)).tenantId;
    sharedSinceDrop = newSourceId('shared-since-drop');
    sharedFromStart = newSourceId('shared-from-start');
    await db.previousReleaseInsert(tenantA, sharedSinceDrop, 'tenant A, previous release');

    // ...then the corpus #1813 merged, whose 351 dropped 062's index, and its
    // traffic: with only the tenant-aware key left, two tenants now share tuples.
    await db.deployCorpus(mergedReleaseMigrations());
    await repo.insert(chunk(tenantB, sharedSinceDrop, 'tenant B, after the drop'));
    await repo.insert(chunk(tenantA, sharedFromStart, 'tenant A, after the drop'));
    await repo.insert(chunk(tenantB, sharedFromStart, 'tenant B, after the drop'));
    rowsBefore = new Map([
      [sharedSinceDrop, await db.rowsFor(sharedSinceDrop)],
      [sharedFromStart, await db.rowsFor(sharedFromStart)],
    ]);
    for (const rows of rowsBefore.values()) expect(rows.map((r) => r.tenant_id)).toEqual([tenantA, tenantB]);
    expect(shape(await db.dedupeKeys())).toEqual([TENANT_AWARE_KEY]);
  });

  afterAll(async () => {
    restoreFlag();
    await db.drop();
  });

  it("this release's runner succeeds twice, never rebuilding 062's key over the shared tuples", async () => {
    const keysBefore = await db.dedupeKeys();

    await expect(db.deployThisRelease()).resolves.toBeUndefined();
    expect(await db.dedupeKeys()).toEqual(keysBefore);
    await expect(db.deployThisRelease()).resolves.toBeUndefined();
    expect(await db.dedupeKeys()).toEqual(keysBefore);

    // Only the tenant-aware key, same OID, and every tenant's copy intact.
    expect(shape(await db.dedupeKeys())).toEqual([TENANT_AWARE_KEY]);
    for (const [sourceId, rows] of rowsBefore) expect(await db.rowsFor(sourceId)).toEqual(rows);
  });

  it("this release's insert upserts each tenant's own copy of a shared tuple in place", async () => {
    const countBefore = await collisionCount();
    const [rowA, rowB] = rowsBefore.get(sharedFromStart)!;

    const a = await repo.insert(chunk(tenantA, sharedFromStart, 'tenant A, this release'));
    const b = await repo.insert(chunk(tenantB, sharedFromStart, 'tenant B, this release'));

    expect([a.id, b.id]).toEqual([rowA.id, rowB.id]);
    expect((await db.rowsFor(sharedFromStart)).map((r) => [r.tenant_id, r.content])).toEqual([
      [tenantA, 'tenant A, this release'],
      [tenantB, 'tenant B, this release'],
    ]);
    // No tenant-blind key here, so nothing is refused or counted.
    expect(await collisionCount()).toBe(countBefore);
  });

  it("known limit: the previous release's insert fails 42P10 here, with or without this release", async () => {
    // #1813's drop already removed the only index its conflict target names.
    await expect(
      db.previousReleaseInsert(tenantA, newSourceId('previous-release-on-dev'), 'never written'),
    ).rejects.toMatchObject({ code: '42P10' });
  });

  it("known limit: a rollback deploy to the previous release fails 23505 while two tenants share a tuple, and changes nothing", async () => {
    const keysBefore = await db.dedupeKeys();
    const countBefore = await db.rowCount();

    // Its 062 rebuilds the tenant-blind index over the shared tuples.
    await expect(db.deployCorpus(previousReleaseMigrations())).rejects.toMatchObject({ code: '23505' });

    // The corpus is one transaction: it rolled back whole, so rolling forward still works.
    expect(await db.dedupeKeys()).toEqual(keysBefore);
    expect(await db.rowCount()).toBe(countBefore);
    await expect(db.deployThisRelease()).resolves.toBeUndefined();
  });
});
