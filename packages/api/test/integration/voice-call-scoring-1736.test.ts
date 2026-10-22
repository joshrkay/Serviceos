/**
 * #1736 — Postgres integration: `voice_call_scores` (338), `voice_call_corrections`
 * (339), `tenant_settings.call_scoring_enabled` and `PgCallScoreStore`.
 *
 * Pins, against real columns (the store is never only proven by a mocked Pool):
 *   - the opt-in flag defaults OFF and round-trips;
 *   - the unscored-candidate read over the EXISTING eligibility tables
 *     (voice_sessions / consent_events / call_usage_events) excludes scored calls;
 *   - a seeded call scored END-TO-END through `scoreVoiceCall` against the Pg
 *     stores, with the live `catalog_items` rows as the price reference;
 *   - correction upsert replaces + re-queues, and export stamping;
 *   - RLS: FORCE + tenant_isolation on both tables, as the unprivileged role.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import type { LLMResponse } from '../../src/ai/gateway/gateway';
import { PgVoiceSessionGradeStore } from '../../src/voice/quality/pg-voice-session-grade-store';
import { PgCallScoreStore } from '../../src/voice/scoring/pg-call-score-store';
import { createVoiceCallScorer } from '../../src/voice/scoring/score-voice-call';

const APP_ROLE = 'rls_app_runtime';
const NOW = new Date('2026-10-05T08:00:00.000Z');
const WINDOW = { endedSince: new Date('2026-10-04T08:00:00.000Z'), endedBefore: NOW, limit: 100 };

async function seedCall(pool: Pool, tenant: TestTenant, disclosed = true): Promise<string> {
  const id = crypto.randomUUID();
  const endedAt = new Date('2026-10-04T15:02:00.000Z');
  const startedAt = new Date(endedAt.getTime() - 120_000);
  const transcript = [
    'agent: Thanks for calling Rivera Plumbing. This call may be recorded.',
    'caller: How much for a water heater flush?',
    'agent: A water heater flush is $149. Want me to book Thursday?',
    'caller: Yes please.',
    'agent: Booked for Thursday at 10am.',
  ];
  await pool.query(
    `INSERT INTO voice_sessions (id, tenant_id, channel, call_sid, state, started_at, ended_at, ended_reason, outcome, transcript)
     VALUES ($1, $2, 'voice_inbound', $3, 'closing', $4, $5, 'hangup', 'completed', $6::jsonb)`,
    [id, tenant.tenantId, `CA${id.replace(/-/g, '').slice(0, 30)}`, startedAt, endedAt, JSON.stringify(transcript)],
  );
  if (disclosed) {
    await pool.query(
      `INSERT INTO consent_events (tenant_id, customer_id, phone_normalized, kind, state, source, voice_session_id)
       VALUES ($1, NULL, '+16025550101', 'recording', 'implicit', 'voice', $2)`,
      [tenant.tenantId, id],
    );
  }
  await pool.query(
    `INSERT INTO call_usage_events (tenant_id, call_id, caller_phone, started_at, ended_at, duration_seconds, billable, not_billable_reason)
     VALUES ($1, $2, '+16025550101', $3, $4, 120, true, NULL)`,
    [tenant.tenantId, id, startedAt, endedAt],
  );
  return id;
}

async function asTenantRole<T>(pool: Pool, tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const JUDGE_REPLY = JSON.stringify({
  items: [
    { id: 'booked', verdict: 'pass', rationale: 'Booked Thursday' },
    { id: 'price_grounded', verdict: 'pass', rationale: 'Matches catalog' },
    { id: 'escalation_handled', verdict: 'not_applicable', rationale: 'Nothing to escalate' },
    { id: 'follow_up_set', verdict: 'pass', rationale: 'Appointment set' },
  ],
  flags: [{ kind: 'strength', turnIndex: 0, note: 'Quoted and offered a slot in one breath' }],
  summary: 'Booked a flush at the catalog price.',
});

describe('Postgres integration — call scoring (#1736)', () => {
  let pool: Pool;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let store: PgCallScoreStore;
  let sessions: PgVoiceSessionGradeStore;
  let call: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    for (const t of [tenantA, tenantB]) {
      await pool.query(
        `INSERT INTO tenant_settings (tenant_id, business_name, timezone) VALUES ($1, 'Rivera Plumbing', 'America/Phoenix')
         ON CONFLICT (tenant_id) DO NOTHING`,
        [t.tenantId],
      );
    }
    await pool.query(
      `INSERT INTO catalog_items (tenant_id, name, category, unit, unit_price_cents, product_service_type)
       VALUES ($1, 'Water heater flush', 'Labor', 'each', 14900, 'service'),
              ($1, 'Archived item', 'Labor', 'each', 99900, 'service')`,
      [tenantA.tenantId],
    );
    await pool.query(`UPDATE catalog_items SET archived_at = NOW() WHERE tenant_id = $1 AND name = 'Archived item'`, [
      tenantA.tenantId,
    ]);
    store = new PgCallScoreStore(pool);
    sessions = new PgVoiceSessionGradeStore(pool);
    call = await seedCall(pool, tenantA);
    await seedCall(pool, tenantA, false);
  }, 120_000);

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('call scoring is OFF by default and the flag round-trips per tenant', async () => {
    expect(await store.isEnabled(tenantA.tenantId)).toBe(false);
    await store.setEnabled(tenantA.tenantId, true);
    expect(await store.isEnabled(tenantA.tenantId)).toBe(true);
    expect(await store.isEnabled(tenantB.tenantId)).toBe(false);
  });

  it('reads the live (non-archived) catalog for the price reference', async () => {
    expect(await store.listCatalogPrices(tenantA.tenantId, 50)).toEqual([
      { name: 'Water heater flush', unitPriceCents: 14900 },
    ]);
    expect(await store.listCatalogPrices(tenantB.tenantId, 50)).toEqual([]);
  });

  it('lists only eligible unscored calls, scores one end-to-end, then stops listing it', async () => {
    expect(await store.listUnscoredCandidates(tenantA.tenantId, WINDOW)).toEqual([call]);

    const gateway = {
      complete: vi.fn(async (): Promise<LLMResponse> => ({
        content: JUDGE_REPLY,
        model: 'judge-mock-1',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
        costMicroCents: 123_000,
      })),
    };
    const result = await createVoiceCallScorer({ store, sessions, gateway, now: () => NOW }).scoreVoiceCall(
      tenantA.tenantId,
      call,
    );
    expect(result.status).toBe('scored');

    const stored = await store.findScore(tenantA.tenantId, call);
    expect(stored).toMatchObject({ score: 100, model: 'judge-mock-1', costMicroCents: 123_000, rubricVersion: 'v1' });
    expect(stored?.items).toHaveLength(4);
    expect(stored?.flags[0]).toMatchObject({ kind: 'strength', turnIndex: 0 });
    expect(await store.listScores(tenantA.tenantId, 10)).toHaveLength(1);
    expect(await store.listScores(tenantB.tenantId, 10)).toEqual([]);
    expect(await store.listUnscoredCandidates(tenantA.tenantId, WINDOW)).toEqual([]);
  });

  it('a correction upserts per call, re-queues after export, and is stamped on export', async () => {
    const base = {
      tenantId: tenantA.tenantId,
      sessionId: call,
      turnIndex: 1,
      createdBy: 'user_owner',
      createdAt: NOW,
      exportedAt: null,
      corpusScriptId: null,
    };
    const first = await store.saveCorrection({ ...base, id: crypto.randomUUID(), kind: 'wrong_price', note: 'first' });
    expect((await store.listPendingExport(tenantA.tenantId)).map((c) => c.id)).toEqual([first.id]);

    await store.markExported(tenantA.tenantId, first.id, 'owner-correction-abc', NOW);
    expect(await store.listPendingExport(tenantA.tenantId)).toEqual([]);
    expect(await store.findCorrection(tenantA.tenantId, call)).toMatchObject({
      corpusScriptId: 'owner-correction-abc',
      exportedAt: NOW,
    });

    const second = await store.saveCorrection({ ...base, id: crypto.randomUUID(), kind: 'other', note: 'second' });
    expect(second.id).toBe(first.id); // same row, replaced
    expect(second).toMatchObject({ kind: 'other', note: 'second', exportedAt: null, corpusScriptId: null });
    expect(await store.listPendingExport(tenantA.tenantId)).toHaveLength(1);
    expect(await store.listCorrectionsForSessions(tenantA.tenantId, [call])).toHaveLength(1);
    expect(await store.listCorrectionsForSessions(tenantB.tenantId, [call])).toEqual([]);
  });

  it('isolates scores and corrections per tenant under RLS (FORCE + tenant_isolation, as the runtime role)', async () => {
    for (const table of ['voice_call_scores', 'voice_call_corrections']) {
      const flags = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [table],
      );
      expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

      const own = await asTenantRole(pool, tenantA.tenantId, (c) =>
        c.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [tenantA.tenantId]),
      );
      expect(own.rowCount).toBe(1);
      const other = await asTenantRole(pool, tenantB.tenantId, (c) =>
        c.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [tenantA.tenantId]),
      );
      expect(other.rowCount).toBe(0);
    }
  });

  it('rejects a score outside 0-100 and an unknown correction kind at the database', async () => {
    await expect(
      pool.query(
        `INSERT INTO voice_call_scores (tenant_id, session_id, score, items, model, call_ended_at)
         VALUES ($1, $2, 101, '[]'::jsonb, 'm', NOW())`,
        [tenantA.tenantId, call],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO voice_call_corrections (tenant_id, session_id, kind, created_by)
         VALUES ($1, $2, 'nonsense', 'u')`,
        [tenantB.tenantId, call],
      ),
    ).rejects.toThrow();
  });
});
