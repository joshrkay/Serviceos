/**
 * Voice parity U1 (D-043) — the owner's 7-day reply-gap summary on real
 * Postgres. Pins the aggregate query against the real migration-325 columns
 * (the mocked-pool trap in
 * docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md):
 * rows are written through the real `PgCallTranscriptTurnRepository`
 * (`recordTurn` at append time, `markReplyAudio` when the reply played) and
 * read back through `createPgLatencySummaryReader`.
 *
 * Seed for tenant A: eight calls. Six realtime calls carry 12 acked gaps
 * (600..1700 ms) and 2 unacked replies (ack_timeout, clear_echo); two Gather
 * calls carry 3 turns. Agent turns, a turn with no transport (pre-migration
 * shape) and a gap older than the window are noise the summary must ignore.
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  getSharedTestDb,
  closeSharedTestDb,
  createTestTenant,
  RLS_APP_ROLE,
  type TestTenant,
} from './shared';
import { PgCallTranscriptTurnRepository } from '../../src/voice/pg-call-transcript-turn';
import {
  createPgLatencySummaryReader,
  type LatencySummaryReader,
} from '../../src/voice/quality/latency-summary';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Postgres integration — voice quality latency summary (U1)', () => {
  let pool: Pool;
  let repo: PgCallTranscriptTurnRepository;
  let reader: LatencySummaryReader;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let tenantC: TestTenant;
  let seq = 0;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCallTranscriptTurnRepository(pool);
    reader = createPgLatencySummaryReader(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    tenantC = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function newCall(): { callSid: string; sessionId: string } {
    seq += 1;
    const id = `${String(seq).padStart(4, '0')}${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    return { callSid: `CALAT${id}`, sessionId: `sess-${id}` };
  }

  async function realtimeGapTurn(
    tenant: TestTenant,
    call: { callSid: string; sessionId: string },
    turnIndex: number,
    gapMs: number,
    endpointDelayMs: number,
    opts: { startedAt?: Date } = {},
  ): Promise<void> {
    const lastWordAt = new Date('2026-10-20T10:00:00.000Z');
    await repo.recordTurn({
      tenantId: tenant.tenantId,
      ...call,
      turnIndex,
      speaker: 'caller',
      text: `caller line ${turnIndex}`,
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
      lastWordAt,
      sttFinalAt: new Date(lastWordAt.getTime() + endpointDelayMs),
      endpointDelayMs,
      transport: 'realtime',
    });
    const firstAudioAt = new Date(lastWordAt.getTime() + gapMs);
    await repo.markReplyAudio({
      tenantId: tenant.tenantId,
      ...call,
      turnIndex,
      firstAudibleAt: firstAudioAt,
      firstAudioEnqueuedAt: new Date(firstAudioAt.getTime() - 50),
      firstAudioAt,
      replyGapMs: gapMs,
    });
  }

  async function realtimeUnackedTurn(
    tenant: TestTenant,
    call: { callSid: string; sessionId: string },
    turnIndex: number,
    reason: 'clear_echo' | 'ack_timeout' | 'stream_closed',
  ): Promise<void> {
    await repo.recordTurn({
      tenantId: tenant.tenantId,
      ...call,
      turnIndex,
      speaker: 'caller',
      text: `unacked line ${turnIndex}`,
      lastWordAt: new Date('2026-10-20T10:05:00.000Z'),
      sttFinalAt: new Date('2026-10-20T10:05:00.800Z'),
      endpointDelayMs: 800,
      transport: 'realtime',
    });
    await repo.markReplyAudio({
      tenantId: tenant.tenantId,
      ...call,
      turnIndex,
      firstAudioEnqueuedAt: new Date('2026-10-20T10:05:01.200Z'),
      replyUnackedReason: reason,
    });
  }

  async function gatherTurn(
    tenant: TestTenant,
    call: { callSid: string; sessionId: string },
    turnIndex: number,
  ): Promise<void> {
    await repo.recordTurn({
      tenantId: tenant.tenantId,
      ...call,
      turnIndex,
      speaker: 'caller',
      text: `gather line ${turnIndex}`,
      sttFinalAt: new Date('2026-10-20T11:00:00.000Z'),
      transport: 'gather',
    });
  }

  beforeAll(async () => {
    // Tenant A — six realtime calls, two acked gaps each (600..1700 ms).
    const realtimeCalls = Array.from({ length: 6 }, () => newCall());
    let gap = 600;
    let delay = 500;
    for (const call of realtimeCalls) {
      for (const turnIndex of [0, 1]) {
        await realtimeGapTurn(tenantA, call, turnIndex, gap, delay);
        gap += 100;
        delay += 20;
      }
    }
    // Two unacked replies, on calls that already have acked turns.
    await realtimeUnackedTurn(tenantA, realtimeCalls[0]!, 2, 'ack_timeout');
    await realtimeUnackedTurn(tenantA, realtimeCalls[1]!, 2, 'clear_echo');
    // Noise the summary must not count: an agent turn, and a caller turn with
    // no transport (the pre-migration shape).
    await repo.recordTurn({
      tenantId: tenantA.tenantId,
      ...realtimeCalls[0]!,
      turnIndex: 3,
      speaker: 'agent',
      text: 'agent line',
    });
    await repo.recordTurn({
      tenantId: tenantA.tenantId,
      ...realtimeCalls[2]!,
      turnIndex: 3,
      speaker: 'caller',
      text: 'legacy caller line',
    });
    // Three Gather turns across two calls.
    const g1 = newCall();
    const g2 = newCall();
    await gatherTurn(tenantA, g1, 0);
    await gatherTurn(tenantA, g1, 1);
    await gatherTurn(tenantA, g2, 0);
    // A slow turn from a month ago sits outside the 7-day window.
    await realtimeGapTurn(tenantA, newCall(), 0, 9000, 4000, {
      startedAt: new Date(Date.now() - 30 * DAY_MS),
    });

    // Tenant B — five realtime gaps: fewer than the 10-turn floor.
    const bCall = newCall();
    for (let i = 0; i < 5; i += 1) await realtimeGapTurn(tenantB, bCall, i, 1000 + i * 10, 300);
  });

  it('reduces tenant A\'s window: percentiles over acked realtime gaps, unacked rate, Gather share', async () => {
    const s = await reader.read(tenantA.tenantId, { days: 7 });

    expect(s.sampleTurns).toBe(12);
    // Gaps 600..1700 step 100: p50 = 1150, p95 = 1600 + 0.45 * 100.
    expect(s.p50ReplyGapMs).toBe(1150);
    expect(s.p95ReplyGapMs).toBe(1645);
    // 2 unacked of the 14 realtime turns that attempted a reply.
    expect(s.unacked.total).toBe(2);
    expect(s.unacked.rate).toBeCloseTo(2 / 14, 10);
    expect(s.unacked.byReason).toEqual({ clear_echo: 1, ack_timeout: 1, stream_closed: 0 });

    // 2 of 8 calls and 3 of 17 caller turns ran on Gather; agent turns, the
    // transport-less row and the month-old call are not in either figure.
    expect(s.gatherShare.calls).toBeCloseTo(2 / 8, 10);
    expect(s.gatherShare.turns).toBeCloseTo(3 / 17, 10);
    expect(s.enough).toBe(true);
  });

  it('computes the endpoint-delay p95 over every in-window realtime turn that carries one', async () => {
    const s = await reader.read(tenantA.tenantId, { days: 7 });
    // 12 acked turns: 500..720 step 20, plus two unacked turns at 800.
    const delays = [...Array.from({ length: 12 }, (_, i) => 500 + i * 20), 800, 800];
    const rank = 0.95 * (delays.length - 1);
    const lo = Math.floor(rank);
    const expected = Math.round(delays[lo]! + (delays[lo + 1]! - delays[lo]!) * (rank - lo));
    expect(s.p95EndpointDelayMs).toBe(expected);
  });

  it('a longer window brings the month-old slow turn in', async () => {
    const s = await reader.read(tenantA.tenantId, { days: 60 });
    expect(s.sampleTurns).toBe(13);
    expect(s.p95ReplyGapMs).toBeGreaterThan(1645);
  });

  it('a tenant with 5 timed turns is "not enough calls" but still reports what it has', async () => {
    const s = await reader.read(tenantB.tenantId, { days: 7 });
    expect(s.sampleTurns).toBe(5);
    expect(s.enough).toBe(false);
    expect(s.p50ReplyGapMs).toBe(1020);
    expect(s.unacked).toEqual({
      rate: 0,
      total: 0,
      byReason: { clear_echo: 0, ack_timeout: 0, stream_closed: 0 },
    });
    expect(s.gatherShare.calls).toBe(0);
  });

  it('a tenant with no calls gets nulls, not zeros or a division error', async () => {
    const s = await reader.read(tenantC.tenantId, { days: 7 });
    expect(s).toEqual({
      sampleTurns: 0,
      p50ReplyGapMs: null,
      p95ReplyGapMs: null,
      p95EndpointDelayMs: null,
      unacked: { rate: null, total: 0, byReason: { clear_echo: 0, ack_timeout: 0, stream_closed: 0 } },
      gatherShare: { calls: null, turns: null },
      enough: false,
    });
  });

  it('RLS: under another tenant\'s context tenant A\'s rows are invisible even without a tenant filter', async () => {
    async function visibleTurns(tenantId: string): Promise<number> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${RLS_APP_ROLE}`);
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
        const { rows } = await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM call_transcript_turns WHERE call_sid LIKE 'CALAT%' AND transport = 'gather'`,
        );
        return Number(rows[0]!.n);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    expect(await visibleTurns(tenantA.tenantId)).toBe(3);
    expect(await visibleTurns(tenantB.tenantId)).toBe(0);
  });
});
