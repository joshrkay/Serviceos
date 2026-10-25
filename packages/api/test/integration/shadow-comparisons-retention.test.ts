/**
 * Postgres integration — the shadow-comparison retention sweep (#1813
 * follow-up) against the REAL schema, with RLS_RUNTIME_ROLE=true.
 *
 * `shadow_comparisons` (migration 352) stores PII-scrubbed primary and shadow
 * LLM reply text for every SAMPLED call while SHADOW_LLM_ENABLED is on. Before
 * this sweep nothing ever deleted a row. The sweep deletes rows older than
 * SHADOW_COMPARISON_RETENTION_DAYS across every tenant AND the all-zero
 * placeholder bucket that platform ('system') calls are filed under: a
 * cross-tenant selection (withCrossTenantSweep, rls_cross_tenant) of the
 * tenants with due rows, then one bounded DELETE per tenant under that
 * tenant's RLS context (withTenantTransaction).
 *
 * Rows are written by the product writer (PgShadowComparisonStore.save, whose
 * `sampledAt` is the row's created_at), so the fixture clock is the only thing
 * the test controls. Every file shares one database, so assertions are scoped
 * to this file's tenants (and, in the shared placeholder bucket, to its own
 * task type): never the sweep's global counts. The window is pinned on both sides of the boundary (an
 * hour inside it is kept, an hour past it is deleted), the batch bound across
 * three consecutive sweeps, the per-tenant audit trail, and the leader gate
 * app.ts registers the sweep behind.
 */
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, type TestTenant } from './shared';
import {
  PgShadowComparisonStore,
  PLACEHOLDER_TENANT_ID,
} from '../../src/ai/evaluation/pg-shadow-comparison';
import type { ShadowComparisonResult } from '../../src/ai/evaluation/shadow-comparison';
import { SYSTEM_TENANT_ID } from '../../src/ai/gateway/gateway';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { runLeaderGatedTick } from '../../src/workers/leader-tick';
import {
  FIND_TENANTS_WITH_DUE_SQL,
  PgShadowComparisonRetentionRepository,
  buildShadowComparisonPurgeAudit,
  runShadowComparisonRetentionSweep,
  type PurgedShadowComparison,
} from '../../src/workers/shadow-comparison-retention-worker';
import type { Logger } from '../../src/logging/logger';

const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const WINDOW_DAYS = 365;
const RUN = crypto.randomUUID().slice(0, 8);
/** Placeholder-bucket rows are told apart from other files' by task type. */
const PLATFORM_TASK = `retention_probe_${RUN}`;

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/** The real repository, recording how many rows each purgeDue call deleted per tenant. */
class RecordingRepo extends PgShadowComparisonRetentionRepository {
  batches = new Map<string, number[]>();
  override async purgeDue(...args: Parameters<PgShadowComparisonRetentionRepository['purgeDue']>) {
    const batch = await super.purgeDue(...args);
    this.batches.set(args[0], [...(this.batches.get(args[0]) ?? []), batch.rows.length]);
    return batch;
  }
}

let pool: Pool;
let store: PgShadowComparisonStore;
let repo: RecordingRepo;
let auditRepo: PgAuditRepository;
const createdTenantIds: string[] = [];
const NOW = new Date();

function at(ageMs: number): Date {
  return new Date(NOW.getTime() - ageMs);
}

async function save(tenantId: string, taskType: string, sampledAt: Date): Promise<string> {
  const result: ShadowComparisonResult = {
    id: crypto.randomUUID(),
    comparisonGroupId: crypto.randomUUID(),
    taskType,
    primaryResponse: {
      content: 'primary reply for jo@example.com',
      model: 'primary-model',
      provider: 'p',
      tokenUsage: { input: 1, output: 2, total: 3 },
      latencyMs: 10,
    },
    shadowResponse: {
      content: 'shadow reply',
      model: 'shadow-model',
      provider: 's',
      tokenUsage: { input: 4, output: 5, total: 9 },
      latencyMs: 20,
    },
    sampledAt,
    tenantId,
  };
  await store.save(result);
  return result.id;
}

async function idsFor(tenantId: string, taskType?: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM shadow_comparisons
      WHERE tenant_id = $1 AND ($2::text IS NULL OR task_type = $2)
      ORDER BY created_at ASC`,
    [tenantId, taskType ?? null],
  );
  return rows.map((r) => r.id);
}

/** A recording on `tenantId` at `createdAt`; `legalHold` as given. */
async function recording(tenantId: string, createdAt: Date, legalHold: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO voice_recordings (tenant_id, created_by, legal_hold, created_at)
     VALUES ($1, 'shadow-retention-test', $2, $3)`,
    [tenantId, legalHold, createdAt],
  );
}

async function purgeAudits(tenantId: string) {
  const events = await auditRepo.findByEntity(tenantId, 'tenant', tenantId);
  return events.filter((e) => e.eventType === 'shadow_comparison.purged');
}

async function seedTenant(): Promise<TestTenant> {
  const t = await createTestTenant(pool);
  createdTenantIds.push(t.tenantId);
  return t;
}

/** The audit builder the sweep hands purgeDue, for direct repository calls. */
function auditFor(tenantId: string) {
  return (rows: ReadonlyArray<PurgedShadowComparison>) =>
    buildShadowComparisonPurgeAudit(tenantId, rows, WINDOW_DAYS);
}

function sweep(batchSize?: number, logger: Logger = silentLogger) {
  return runShadowComparisonRetentionSweep({
    repo,
    logger,
    retentionDays: WINDOW_DAYS,
    ...(batchSize ? { batchSize } : {}),
    now: () => NOW,
  });
}

beforeAll(async () => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  pool = await getSharedTestDb();
  store = new PgShadowComparisonStore(pool);
  repo = new RecordingRepo(pool);
  auditRepo = new PgAuditRepository(pool);
});

afterAll(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  await pool
    .query('DELETE FROM shadow_comparisons WHERE tenant_id = $1 AND task_type = $2', [
      PLACEHOLDER_TENANT_ID,
      PLATFORM_TASK,
    ])
    .catch(() => undefined);
  for (const tenantId of createdTenantIds) {
    await pool.query('DELETE FROM shadow_comparisons WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM audit_events WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM voice_recordings WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('shadow-comparison retention sweep (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  it('deletes only rows past the window, for two tenants and the placeholder bucket, in bounded batches', async () => {
    expect(process.env.RLS_RUNTIME_ROLE).toBe('true');
    const a = await seedTenant();
    const b = await seedTenant();
    const pastWindow = WINDOW_DAYS * DAY_MS + HOUR_MS;
    const insideWindow = WINDOW_DAYS * DAY_MS - HOUR_MS;

    const aOld1 = await save(a.tenantId, 'classify_intent', at(pastWindow + 30 * DAY_MS));
    const aOld2 = await save(a.tenantId, 'classify_intent', at(pastWindow + 20 * DAY_MS));
    const aOld3 = await save(a.tenantId, 'summarize_conversation', at(pastWindow));
    const aInside = await save(a.tenantId, 'classify_intent', at(insideWindow));
    const aFresh = await save(a.tenantId, 'classify_intent', at(HOUR_MS));
    const bOld1 = await save(b.tenantId, 'draft_estimate', at(pastWindow + 100 * DAY_MS));
    const bOld2 = await save(b.tenantId, 'draft_estimate', at(pastWindow + 1 * DAY_MS));
    const bInside = await save(b.tenantId, 'draft_estimate', at(insideWindow));
    // A platform call ('system') is filed under the all-zero placeholder tenant.
    const pOld1 = await save(SYSTEM_TENANT_ID, PLATFORM_TASK, at(pastWindow + 50 * DAY_MS));
    const pOld2 = await save(SYSTEM_TENANT_ID, PLATFORM_TASK, at(pastWindow + 2 * DAY_MS));
    const pFresh = await save(SYSTEM_TENANT_ID, PLATFORM_TASK, at(HOUR_MS));
    expect(await idsFor(PLACEHOLDER_TENANT_ID, PLATFORM_TASK)).toEqual([pOld1, pOld2, pFresh]);

    // Sweep 1, batch 2: each tenant loses at most its two OLDEST due rows.
    expect((await sweep(2)).tenantsFailed).toBe(0);
    expect(repo.batches.get(a.tenantId)).toEqual([2]);
    expect(repo.batches.get(b.tenantId)).toEqual([2]);
    expect(await idsFor(a.tenantId)).toEqual([aOld3, aInside, aFresh]);
    expect(await idsFor(b.tenantId)).toEqual([bInside]);
    expect(await idsFor(PLACEHOLDER_TENANT_ID, PLATFORM_TASK)).toEqual([pFresh]);

    // Sweep 2 takes the remainder of A's backlog; B has nothing due and is
    // not selected.
    await sweep(2);
    expect(repo.batches.get(a.tenantId)).toEqual([2, 1]);
    expect(repo.batches.get(b.tenantId)).toEqual([2]);
    expect(await idsFor(a.tenantId)).toEqual([aInside, aFresh]);

    // Sweep 3 selects neither: the rows an hour inside the window are kept.
    await sweep(2);
    expect(repo.batches.get(a.tenantId)).toEqual([2, 1]);
    expect(repo.batches.get(b.tenantId)).toEqual([2]);
    expect(await idsFor(a.tenantId)).toEqual([aInside, aFresh]);
    expect(await idsFor(b.tenantId)).toEqual([bInside]);
    expect(await idsFor(PLACEHOLDER_TENANT_ID, PLATFORM_TASK)).toEqual([pFresh]);
    for (const gone of [aOld1, aOld2, bOld1, bOld2, pOld1, pOld2]) {
      expect((await pool.query('SELECT 1 FROM shadow_comparisons WHERE id = $1', [gone])).rowCount).toBe(0);
    }

    // One audit event per real-tenant batch, under that tenant; none for the
    // placeholder bucket (no tenants row to attach it to).
    const auditsA = await purgeAudits(a.tenantId);
    expect(auditsA.map((e) => e.metadata?.rowsPurged).sort()).toEqual([1, 2]);
    expect(auditsA.every((e) => e.actorId === 'shadow-comparison-retention-worker')).toBe(true);
    const auditsB = await purgeAudits(b.tenantId);
    expect(auditsB).toHaveLength(1);
    expect(auditsB[0].metadata).toMatchObject({
      reason: 'past_retention',
      retentionDays: WINDOW_DAYS,
      rowsPurged: 2,
      byTaskType: { draft_estimate: 2 },
    });
    const { rows: placeholderAudits } = await pool.query(
      `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'shadow_comparison.purged'`,
      [PLACEHOLDER_TENANT_ID],
    );
    expect(placeholderAudits).toHaveLength(0);
  });

  it("a tenant's purge deletes only that tenant's rows; the selection still sees every tenant", async () => {
    const a = await seedTenant();
    const b = await seedTenant();
    const old = at(WINDOW_DAYS * DAY_MS + 10 * DAY_MS);
    await save(a.tenantId, 'classify_intent', old);
    const bOld = await save(b.tenantId, 'classify_intent', old);

    const purged = await repo.purgeDue(a.tenantId, NOW, WINDOW_DAYS, 500, auditFor(a.tenantId));
    expect(purged).toEqual({ rows: [{ taskType: 'classify_intent', createdAt: old }], audited: true });
    expect(await idsFor(a.tenantId)).toEqual([]);
    expect(await idsFor(b.tenantId)).toEqual([bOld]);

    // The selection is cross-tenant: B's due row is still found.
    expect(await repo.findTenantsWithDue(NOW, WINDOW_DAYS, 100)).toContain(b.tenantId);
    await repo.purgeDue(b.tenantId, NOW, WINDOW_DAYS, 500, auditFor(b.tenantId));
  });

  it('a call on legal hold keeps its shadow rows; an unheld call in the same tenant loses them', async () => {
    // Every other retention phase exempts a held call (PRIV-1 keeps ai_runs
    // content within a day of a held recording); these rows are the same
    // model replies, scrubbed.
    const t = await seedTenant();
    const heldCallAt = at(400 * DAY_MS);
    const otherCallAt = at(420 * DAY_MS);
    await recording(t.tenantId, heldCallAt, true);
    await recording(t.tenantId, otherCallAt, false);
    const heldClassify = await save(t.tenantId, 'classify_intent', new Date(heldCallAt.getTime() - 5 * 60_000));
    const heldSummary = await save(t.tenantId, 'summarize_conversation', new Date(heldCallAt.getTime() + 10 * 60_000));
    const otherClassify = await save(t.tenantId, 'classify_intent', new Date(otherCallAt.getTime() - 5 * 60_000));
    const otherSummary = await save(t.tenantId, 'summarize_conversation', new Date(otherCallAt.getTime() + 10 * 60_000));
    // Just over a day before the held recording: not that call's row.
    const outsideHold = await save(t.tenantId, 'classify_intent', new Date(heldCallAt.getTime() - DAY_MS - HOUR_MS));

    await sweep();
    expect(await idsFor(t.tenantId)).toEqual([heldClassify, heldSummary]);
    for (const gone of [otherClassify, otherSummary, outsideHold]) {
      expect((await pool.query('SELECT 1 FROM shadow_comparisons WHERE id = $1', [gone])).rowCount).toBe(0);
    }
    const audits = await purgeAudits(t.tenantId);
    expect(audits.map((e) => e.metadata?.rowsPurged)).toEqual([3]);

    // Later sweeps keep the held call's rows for as long as the hold stands.
    await sweep();
    expect(await idsFor(t.tenantId)).toEqual([heldClassify, heldSummary]);
  });

  it('a tenant whose only due rows belong to a held call takes no selection slot, and its purge deletes nothing', async () => {
    const t = await seedTenant();
    // Far older than any other due row, so without the hold it would rank first.
    const heldCallAt = at(4000 * DAY_MS);
    await recording(t.tenantId, heldCallAt, true);
    const held = await save(t.tenantId, 'classify_intent', heldCallAt);

    expect(await repo.findTenantsWithDue(NOW, WINDOW_DAYS, 100)).not.toContain(t.tenantId);
    expect(await repo.purgeDue(t.tenantId, NOW, WINDOW_DAYS, 500, auditFor(t.tenantId))).toEqual({
      rows: [],
      audited: false,
    });
    expect(await idsFor(t.tenantId)).toEqual([held]);
    expect(await purgeAudits(t.tenantId)).toEqual([]);
  });

  it('the audit row commits with the delete: an audit insert that fails rolls the batch back for the next sweep', async () => {
    // Without this, the delete committed first and the audit was a separate,
    // best-effort write, so a crash or a failed insert between the two left
    // an unaudited purge.
    const t = await seedTenant();
    const due1 = await save(t.tenantId, 'classify_intent', at(WINDOW_DAYS * DAY_MS + 3 * DAY_MS));
    const due2 = await save(t.tenantId, 'summarize_conversation', at(WINDOW_DAYS * DAY_MS + 2 * DAY_MS));
    const trigger = `shadow_retention_audit_fail_${RUN}`;
    await pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $f$
         BEGIN
           IF NEW.tenant_id = '${t.tenantId}'::uuid AND NEW.event_type = 'shadow_comparison.purged' THEN
             RAISE EXCEPTION 'injected audit failure';
           END IF;
           RETURN NEW;
         END $f$`,
    );
    await pool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      await sweep();
      expect(await idsFor(t.tenantId)).toEqual([due1, due2]);
      expect(await purgeAudits(t.tenantId)).toEqual([]);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`);
      await pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    }

    await sweep();
    expect(await idsFor(t.tenantId)).toEqual([]);
    const audits = await purgeAudits(t.tenantId);
    expect(audits.map((e) => e.metadata?.rowsPurged)).toEqual([2]);
  });

  it("a deprovisioned tenant's late rows (no tenants row) are purged unaudited, not retried forever", async () => {
    // shadow_comparisons has no tenants FK, so a sample saved after its
    // tenant was deprovisioned outlives the tenants row that audit_events
    // references. Failing that batch on the FK every sweep would keep the
    // rows and the tenant's selection slot forever.
    const orphan = crypto.randomUUID();
    const lines: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (message, meta) => {
        lines.push({ message, ...(meta ? { meta } : {}) });
      },
      child: () => logger,
    };
    try {
      await save(orphan, 'classify_intent', at(WINDOW_DAYS * DAY_MS + 5 * DAY_MS));
      await sweep(undefined, logger);
      expect(await idsFor(orphan)).toEqual([]);
      expect(lines.filter((l) => l.meta?.tenantId === orphan)).toEqual([
        {
          message: 'shadow-comparison retention sweep: purged rows of a tenant with no tenants row, unaudited',
          meta: { tenantId: orphan, rowsPurged: 1 },
        },
      ]);
      const { rowCount } = await pool.query('SELECT 1 FROM audit_events WHERE tenant_id = $1', [orphan]);
      expect(rowCount).toBe(0);
    } finally {
      await pool.query('DELETE FROM shadow_comparisons WHERE tenant_id = $1', [orphan]);
    }
  });

  it('selects at most `limit` tenants, oldest due row first (LIMIT and ORDER BY are both load-bearing)', async () => {
    // Fixed ids, so neither tenant_id order (ascending or descending) nor
    // any other row order matches the expected one; rows decades older than
    // anything another test writes, so these five lead the selection.
    const id = (n: number) => `5ade0000-0000-4000-8000-00000000000${n}`;
    const seeded: Array<[string, string[]]> = [
      [id(3), ['1971-01-01', '1999-06-01']],
      [id(1), ['1972-01-01']],
      [id(4), ['1973-01-01', '1973-02-01']],
      [id(2), ['1974-01-01']],
      [id(5), ['1975-01-01']],
    ];
    const cleanup = () =>
      pool.query('DELETE FROM shadow_comparisons WHERE tenant_id = ANY($1::uuid[])', [seeded.map(([t]) => t)]);
    await cleanup();
    try {
      for (const [tenantId, dates] of seeded) {
        for (const date of dates) {
          await pool.query(
            `INSERT INTO shadow_comparisons (id, tenant_id, shadow_model, task_type, created_at)
             VALUES ($1, $2, 'shadow-model', 'classify_intent', $3)`,
            [crypto.randomUUID(), tenantId, new Date(`${date}T00:00:00Z`)],
          );
        }
      }
      expect(await repo.findTenantsWithDue(NOW, WINDOW_DAYS, 3)).toEqual([id(3), id(1), id(4)]);
      expect(await repo.findTenantsWithDue(NOW, WINDOW_DAYS, 1)).toEqual([id(3)]);
    } finally {
      await cleanup();
    }
  });

  it('runs as the leader tick app.ts registers it under; a replica that does not hold the lock deletes nothing', async () => {
    const appSrc = readFileSync(resolve(__dirname, '../../src/app.ts'), 'utf8');
    const match = appSrc.match(/shadowComparisonRetention:\s*(\d{6})/);
    expect(match).not.toBeNull();
    const lockKey = Number(match![1]);

    const t = await seedTenant();
    const due = await save(t.tenantId, 'classify_intent', at(WINDOW_DAYS * DAY_MS + DAY_MS));

    // Another replica holds the leader lock: this tick skips.
    const holder = await pool.connect();
    let ticks = 0;
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [lockKey]);
      await runLeaderGatedTick(pool, lockKey, async () => { await sweep(); }, () => { ticks++; });
      expect(ticks).toBe(0);
      expect(await idsFor(t.tenantId)).toEqual([due]);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      holder.release();
    }

    // Leader: the sweep runs inside the session lease and deletes the row.
    await runLeaderGatedTick(pool, lockKey, async () => { await sweep(); }, () => { ticks++; });
    expect(ticks).toBe(1);
    expect(await idsFor(t.tenantId)).toEqual([]);
  });
});

describe('the tenant selection is index-served (migration 353)', () => {
  it('idx_shadow_comparisons_created leads with created_at', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'shadow_comparisons' AND indexname = 'idx_shadow_comparisons_created'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/ON public\.shadow_comparisons USING btree \(created_at, tenant_id\)/);
  });

  it('EXPLAIN of the selection is a range scan on that index, not a pass over the tenant-leading index or the table', async () => {
    // Many rows inside the window and a few past it: the shape the sweep
    // sees every hour. 352's tenant-leading index can only answer the
    // created_at bound by reading all of itself (or the planner reads the
    // heap); the created_at-leading index narrows to the due rows. Seq scans
    // are off so the plan text is decided between index plans (the
    // jobs-audit-tenant-indexes precedent), and ANALYZE makes the estimate
    // for this shape accurate whatever other files left in the table.
    const t = await seedTenant();
    for (let i = 0; i < 300; i++) {
      await pool.query(
        `INSERT INTO shadow_comparisons (id, tenant_id, shadow_model, task_type, created_at)
         VALUES ($1, $2, 'shadow-model', 'classify_intent', $3)`,
        [crypto.randomUUID(), t.tenantId, at(i * DAY_MS + HOUR_MS)],
      );
    }
    await save(t.tenantId, 'classify_intent', at(WINDOW_DAYS * DAY_MS + DAY_MS));
    await pool.query('ANALYZE shadow_comparisons');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query(`EXPLAIN ${FIND_TENANTS_WITH_DUE_SQL}`, [NOW, WINDOW_DAYS, 100]);
      const plan = rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
      // Index-only once the visibility map is set (VACUUM); a bitmap scan
      // before. Either way the range is the created_at bound on the leading key.
      expect(plan).toMatch(
        /(Index Only Scan using|Index Scan using|Bitmap Index Scan on) idx_shadow_comparisons_created\b/,
      );
      expect(plan).toMatch(/Index Cond: \(created_at < /);
      expect(plan).not.toMatch(/idx_shadow_comparisons_tenant_created/);
      // The legal-hold probe rides migration 321's partial index.
      expect(plan).toMatch(/idx_voice_recordings_legal_hold/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
