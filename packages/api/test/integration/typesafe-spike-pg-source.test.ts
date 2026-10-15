/**
 * TypeSafe spike — PgUtteranceSource against real Postgres + the repo's real
 * migrations (call_transcript_turns 274/278, audit_events 003), including under
 * the RLS runtime role. Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant, RLS_APP_ROLE, type TestTenant } from './shared';
import { PgUtteranceSource } from '../../src/ai/spikes/typesafe/pg-source';
import { extractFrustrationUtterances } from '../../src/ai/spikes/typesafe/extract-utterances';

const T0 = Date.parse('2026-10-01T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('PgUtteranceSource (real Postgres)', () => {
  let pool: Pool;
  let a: TestTenant;
  let b: TestTenant;

  async function turn(t: TestTenant, o: { sid: string; sess: string; idx: number; speaker: string; text: string; at: number }) {
    await pool.query(
      `INSERT INTO call_transcript_turns (tenant_id, call_sid, session_id, turn_index, speaker, text, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [t.tenantId, o.sid, o.sess, o.idx, o.speaker, o.text, iso(o.at)]
    );
  }
  async function audit(t: TestTenant, o: { sess: string; type: string; meta: Record<string, unknown>; at: number }) {
    await pool.query(
      `INSERT INTO audit_events (tenant_id, actor_id, actor_role, event_type, entity_type, entity_id, correlation_id, metadata, created_at)
       VALUES ($1,'calling-agent','system',$2,'voice_session',$3,$3,$4,$5)`,
      [t.tenantId, o.type, o.sess, JSON.stringify(o.meta), iso(o.at)]
    );
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    a = await createTestTenant(pool);
    b = await createTestTenant(pool);

    // Tenant A: one call, caller gets frustrated on turn 1 (keyword), agent turn must be ignored.
    await turn(a, { sid: 'CA_A', sess: 'sess-a', idx: 0, speaker: 'caller', text: 'my AC is out', at: T0 + 1_000 });
    await turn(a, { sid: 'CA_A', sess: 'sess-a', idx: 1, speaker: 'agent', text: 'I can help with that', at: T0 + 2_000 });
    await turn(a, { sid: 'CA_A', sess: 'sess-a', idx: 2, speaker: 'caller', text: 'this is ridiculous call 602-555-0142', at: T0 + 3_000 });
    await audit(a, {
      sess: 'sess-a',
      type: 'agent.calling.intent_capture.keyword_frustration',
      meta: { sessionId: 'sess-a', callSid: 'CA_A', ts: T0 + 3_200 },
      at: T0 + 3_200,
    });
    // Unrelated audit event on the same session must not count.
    await audit(a, { sess: 'sess-a', type: 'agent.calling.intent_capture.noise_reprompt', meta: { ts: T0 + 500 }, at: T0 + 500 });
    // Tenant B has its own frustration; must never appear in A's extraction.
    await turn(b, { sid: 'CA_B', sess: 'sess-b', idx: 0, speaker: 'caller', text: 'tenant b secret', at: T0 + 1_000 });
    await audit(b, { sess: 'sess-b', type: 'agent.calling.escalating.llm_sentiment', meta: { ts: T0 + 1_100 }, at: T0 + 1_100 });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  const window = (t: TestTenant) => ({ tenantId: t.tenantId, from: T0, to: T0 + 60_000 });

  it('lists only caller turns for the tenant, with epoch-ms timestamps', async () => {
    const turns = await new PgUtteranceSource(pool).listCallerTurns(window(a));
    expect(turns.map((t) => [t.sessionId, t.turnIndex, t.text, t.at])).toEqual([
      ['sess-a', 0, 'my AC is out', T0 + 1_000],
      ['sess-a', 2, 'this is ridiculous call 602-555-0142', T0 + 3_000],
    ].sort((x, y) => (x[3] as number) - (y[3] as number)));
  });

  it('lists only keyword/sentiment frustration audit events, using metadata.ts and the event source', async () => {
    const events = await new PgUtteranceSource(pool).listFrustrationEvents(window(a));
    expect(events).toEqual([
      { tenantId: a.tenantId, sessionId: 'sess-a', callSid: 'CA_A', source: 'keyword', at: T0 + 3_200 },
    ]);
    const bEvents = await new PgUtteranceSource(pool).listFrustrationEvents(window(b));
    expect(bEvents.map((e) => e.source)).toEqual(['llm_sentiment']);
  });

  it('end-to-end: extraction marks and scrubs the fired caller turn', async () => {
    const rows = await extractFrustrationUtterances(new PgUtteranceSource(pool), { ...window(a), limit: 50, seed: 1 });
    expect(rows).toEqual([
      { text: 'my AC is out', firedBaseline: false },
      { text: 'this is ridiculous call [PHONE]', firedBaseline: true, eventSource: 'keyword' },
    ]);
  });

  it('works under the RLS runtime role and cannot see another tenant even with its own session', async () => {
    const rlsPool = {
      async connect() {
        const client = await pool.connect();
        await client.query(`SET ROLE ${RLS_APP_ROLE}`);
        const release = client.release.bind(client);
        client.release = () => {
          void client.query('RESET ROLE').finally(() => release());
        };
        return client;
      },
    };
    const src = new PgUtteranceSource(rlsPool);
    const aTurns = await src.listCallerTurns(window(a));
    expect(aTurns.map((t) => t.text)).not.toContain('tenant b secret');
    expect(aTurns).toHaveLength(2);
  });

  it('is read-only: the transaction it opens rejects writes', async () => {
    let writeError: string | undefined;
    const probePool = {
      async connect() {
        const client = await pool.connect();
        const orig = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        let probed = false;
        (client as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => {
          const res = await orig(text, params);
          if (!probed && /set_config/.test(text)) {
            probed = true;
            try {
              await orig('CREATE TEMP TABLE spike_write_probe (x int)');
            } catch (e) {
              writeError = e instanceof Error ? e.message : String(e);
              await orig('ROLLBACK');
              await orig('BEGIN READ ONLY');
              await orig("SELECT set_config('app.current_tenant_id', $1, true)", [a.tenantId]);
            }
          }
          return res;
        };
        return client;
      },
    };
    await new PgUtteranceSource(probePool).listCallerTurns(window(a));
    expect(writeError).toMatch(/read-only transaction/i);
  });
});
