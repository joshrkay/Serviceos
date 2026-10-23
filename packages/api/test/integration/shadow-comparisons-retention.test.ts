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
 * the test controls. The window is pinned on both sides of the boundary (an
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
  PgShadowComparisonRetentionRepository,
  runShadowComparisonRetentionSweep,
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

let pool: Pool;
let store: PgShadowComparisonStore;
let repo: PgShadowComparisonRetentionRepository;
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

function sweep(batchSize?: number) {
  return runShadowComparisonRetentionSweep({
    repo,
    auditRepo,
    logger: silentLogger,
    retentionDays: WINDOW_DAYS,
    ...(batchSize ? { batchSize } : {}),
    now: () => NOW,
  });
}

beforeAll(async () => {
  process.env.RLS_RUNTIME_ROLE = 'true';
  pool = await getSharedTestDb();
  store = new PgShadowComparisonStore(pool);
  repo = new PgShadowComparisonRetentionRepository(pool);
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
    const first = await sweep(2);
    expect(first).toEqual({ tenantsDue: 3, purged: 6, tenantsFailed: 0 });
    expect(await idsFor(a.tenantId)).toEqual([aOld3, aInside, aFresh]);
    expect(await idsFor(b.tenantId)).toEqual([bInside]);
    expect(await idsFor(PLACEHOLDER_TENANT_ID, PLATFORM_TASK)).toEqual([pFresh]);

    // Sweep 2 takes the remainder of A's backlog; nothing else is due.
    const second = await sweep(2);
    expect(second).toEqual({ tenantsDue: 1, purged: 1, tenantsFailed: 0 });
    expect(await idsFor(a.tenantId)).toEqual([aInside, aFresh]);

    // Sweep 3 finds nothing: the rows an hour inside the window are kept.
    expect(await sweep(2)).toEqual({ tenantsDue: 0, purged: 0, tenantsFailed: 0 });
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

    const purged = await repo.purgeDue(a.tenantId, NOW, WINDOW_DAYS, 500);
    expect(purged).toEqual([{ taskType: 'classify_intent', createdAt: old }]);
    expect(await idsFor(a.tenantId)).toEqual([]);
    expect(await idsFor(b.tenantId)).toEqual([bOld]);

    // The selection is cross-tenant: B's due row is still found.
    expect(await repo.findTenantsWithDue(NOW, WINDOW_DAYS, 100)).toContain(b.tenantId);
    await repo.purgeDue(b.tenantId, NOW, WINDOW_DAYS, 500);
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
    expect(await repo.purgeDue(t.tenantId, NOW, WINDOW_DAYS, 500)).toEqual([]);
    expect(await idsFor(t.tenantId)).toEqual([held]);
    expect(await purgeAudits(t.tenantId)).toEqual([]);
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
