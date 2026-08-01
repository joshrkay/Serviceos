import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import {
  DispatchBoardEventBus,
  type DispatchBoardEvent,
} from '../../src/dispatch/board-event-bus';
import type {
  DispatchBoardEventEnvelope,
  DispatchBoardEventTransport,
} from '../../src/dispatch/board-fanout';
import {
  applyRemoteDispatchBoardRevision,
  bumpDispatchBoardRevision,
  enableOrderedDispatchBoardRevisions,
  getDispatchBoardRevision,
  resetDispatchBoardRevisionsForTests,
} from '../../src/dispatch/board-revision';

/**
 * UC-4 — two DispatchBoardEventBus instances (simulating two replicas)
 * sharing one transport, proving the mirror semantics copied from the voice
 * fan-out (U3d): an event published on replica A reaches replica B's local
 * subscribers, while A's own subscriber fires exactly once (the echo of A's
 * own message is dropped by replicaId dedup).
 */

/** In-memory pub/sub shared by both bus instances. Deliberately echoes every
 *  message back to ALL handlers — including the publisher's own — because
 *  that is exactly what Redis pub/sub does; the bus must drop its own echo. */
class SharedFakeTransport implements DispatchBoardEventTransport {
  private readonly handlers: Array<(env: DispatchBoardEventEnvelope) => void> = [];
  publish(env: DispatchBoardEventEnvelope): void {
    for (const handler of this.handlers) handler(env);
  }
  subscribe(handler: (env: DispatchBoardEventEnvelope) => void): void {
    this.handlers.push(handler);
  }
  async close(): Promise<void> {}
}

describe('DispatchBoardEventBus two-instance fan-out (UC-4)', () => {
  beforeEach(() => resetDispatchBoardRevisionsForTests());
  afterEach(() => resetDispatchBoardRevisionsForTests());

  it('B observes A’s event; A’s own subscriber fires exactly once (self-echo dropped)', () => {
    const transport = new SharedFakeTransport();
    const busA = new DispatchBoardEventBus({ replicaId: 'inst-a', transport });
    const busB = new DispatchBoardEventBus({ replicaId: 'inst-b', transport });

    const onA: DispatchBoardEvent[] = [];
    const onB: DispatchBoardEvent[] = [];
    busA.subscribe('t1', '2026-05-20', (e) => onA.push(e));
    busB.subscribe('t1', '2026-05-20', (e) => onB.push(e));

    busA.publishBoardUpdated('t1', '2026-05-20', 'rev-1');

    expect(onB).toEqual([{ type: 'board_updated', date: '2026-05-20', boardRevision: 'rev-1' }]);
    // A's subscriber: once from the synchronous local path; the transport echo
    // must NOT deliver a second time.
    expect(onA).toHaveLength(1);
  });

  it('scopes remote delivery by tenant and date, same as local delivery', () => {
    const transport = new SharedFakeTransport();
    const busA = new DispatchBoardEventBus({ replicaId: 'inst-a', transport });
    const busB = new DispatchBoardEventBus({ replicaId: 'inst-b', transport });

    const otherTenant: DispatchBoardEvent[] = [];
    const otherDate: DispatchBoardEvent[] = [];
    const match: DispatchBoardEvent[] = [];
    busB.subscribe('t2', '2026-05-20', (e) => otherTenant.push(e));
    busB.subscribe('t1', '2026-05-21', (e) => otherDate.push(e));
    busB.subscribe('t1', '2026-05-20', (e) => match.push(e));

    busA.publishPresenceUpdated('t1', '2026-05-20');

    expect(match).toHaveLength(1);
    expect(otherTenant).toHaveLength(0);
    expect(otherDate).toHaveLength(0);
  });

  it('without a transport the bus is local-only (single-replica behavior unchanged)', () => {
    const busA = new DispatchBoardEventBus({ replicaId: 'inst-a' });
    const busB = new DispatchBoardEventBus({ replicaId: 'inst-b' });
    const onB: DispatchBoardEvent[] = [];
    busB.subscribe('t1', '2026-05-20', (e) => onB.push(e));
    busA.publishBoardUpdated('t1', '2026-05-20', 'rev-1');
    expect(onB).toHaveLength(0);
  });

  it('a remote board_updated merges its revision so GET /board on B agrees with A', () => {
    const transport = new SharedFakeTransport();
    new DispatchBoardEventBus({ replicaId: 'inst-b', transport }); // replica B, receiver
    const busA = new DispatchBoardEventBus({ replicaId: 'inst-a', transport });

    // The revision map is module-global in this process, so simulate a token
    // that ONLY replica A ever generated (B never bumped locally): B must
    // learn it from the mirrored board_updated event.
    const rev = `${Date.now()}.7.inst-a`;
    busA.publishBoardUpdated('t1', '2026-05-20', rev);

    expect(getDispatchBoardRevision('t1', '2026-05-20')).toBe(rev);
  });
});

describe('board revision monotonicity across instances (UC-4)', () => {
  beforeEach(() => resetDispatchBoardRevisionsForTests());
  afterAll(() => resetDispatchBoardRevisionsForTests());

  it('keeps the bare-UUID format when fan-out is not enabled (single-replica byte-parity)', () => {
    const rev = bumpDispatchBoardRevision('t1', '2026-05-20');
    expect(rev).toMatch(/^[0-9a-f-]{36}$/);
    expect(getDispatchBoardRevision('t1', '2026-05-20')).toBe(rev);
  });

  it('local bumps strictly increase, even many within one millisecond', () => {
    enableOrderedDispatchBoardRevisions('inst-a');
    const parse = (t: string) => {
      const [ts, seq] = t.split('.');
      return { ts: Number(ts), seq: Number(seq) };
    };
    let prev = bumpDispatchBoardRevision('t1', '2026-05-20');
    for (let i = 0; i < 50; i++) {
      const next = bumpDispatchBoardRevision('t1', '2026-05-20');
      const a = parse(prev);
      const b = parse(next);
      expect(b.ts > a.ts || (b.ts === a.ts && b.seq > a.seq)).toBe(true);
      prev = next;
    }
  });

  it('an older remote revision never overwrites a newer one (max-wins merge)', () => {
    enableOrderedDispatchBoardRevisions('inst-b');
    const local = bumpDispatchBoardRevision('t1', '2026-05-20');
    const [ts] = local.split('.');
    const older = `${Number(ts) - 5_000}.0.inst-a`;
    applyRemoteDispatchBoardRevision('t1', '2026-05-20', older);
    expect(getDispatchBoardRevision('t1', '2026-05-20')).toBe(local);

    const newer = `${Number(ts) + 5_000}.0.inst-a`;
    applyRemoteDispatchBoardRevision('t1', '2026-05-20', newer);
    expect(getDispatchBoardRevision('t1', '2026-05-20')).toBe(newer);
  });

  it('concurrent bumps on two replicas converge to the same winner in either arrival order', () => {
    // Same-millisecond tokens from two replicas — the replicaId breaks the tie
    // deterministically, so both replicas settle on one winner regardless of
    // pub/sub arrival order (no refetch flapping).
    const ts = Date.now();
    const tokenA = `${ts}.0.inst-a`;
    const tokenB = `${ts}.0.inst-b`;

    applyRemoteDispatchBoardRevision('t1', '2026-05-20', tokenA);
    applyRemoteDispatchBoardRevision('t1', '2026-05-20', tokenB);
    const winnerAB = getDispatchBoardRevision('t1', '2026-05-20');

    resetDispatchBoardRevisionsForTests();
    applyRemoteDispatchBoardRevision('t1', '2026-05-20', tokenB);
    applyRemoteDispatchBoardRevision('t1', '2026-05-20', tokenA);
    const winnerBA = getDispatchBoardRevision('t1', '2026-05-20');

    expect(winnerAB).toBe(winnerBA);
    expect(winnerAB).toBe(tokenB); // 'inst-b' > 'inst-a'
  });

  it('a bump after merging a remote token orders strictly above it (skewed-clock safe)', () => {
    enableOrderedDispatchBoardRevisions('inst-b');
    // Remote token from a replica whose clock is far ahead of ours.
    const future = `${Date.now() + 60_000}.3.inst-a`;
    applyRemoteDispatchBoardRevision('t1', '2026-05-20', future);
    const next = bumpDispatchBoardRevision('t1', '2026-05-20');
    const [fTs, fSeq] = future.split('.');
    const [nTs, nSeq] = next.split('.');
    expect(
      Number(nTs) > Number(fTs) ||
        (Number(nTs) === Number(fTs) && Number(nSeq) > Number(fSeq)),
    ).toBe(true);
    expect(getDispatchBoardRevision('t1', '2026-05-20')).toBe(next);
  });

  it('an ordered token always beats a lazy random initial token', () => {
    enableOrderedDispatchBoardRevisions('inst-b');
    const initial = getDispatchBoardRevision('t1', '2026-05-20'); // lazy random (ord=null)
    const remote = `${Date.now() - 60_000}.0.inst-a`; // even an "old" ordered token
    applyRemoteDispatchBoardRevision('t1', '2026-05-20', remote);
    expect(getDispatchBoardRevision('t1', '2026-05-20')).toBe(remote);
    expect(getDispatchBoardRevision('t1', '2026-05-20')).not.toBe(initial);
  });
});

// ─── Real-Redis variant (mirrors voice-fanout-two-instance.test.ts) ─────────
const REDIS_URL = process.env.TEST_REDIS_URL;
const describeRedis = REDIS_URL ? describe : describe.skip;

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describeRedis('DispatchBoardEventBus two-instance Redis fan-out (UC-4, gated)', () => {
  it('B observes A’s event over real Redis; A’s subscriber fires exactly once', async () => {
    const { createRedisDispatchBoardEventTransport } = await import(
      '../../src/dispatch/redis-board-fanout'
    );
    const transportA = await createRedisDispatchBoardEventTransport(REDIS_URL);
    const transportB = await createRedisDispatchBoardEventTransport(REDIS_URL);
    expect(transportA).not.toBeNull();
    expect(transportB).not.toBeNull();
    try {
      const busA = new DispatchBoardEventBus({ replicaId: 'inst-a', transport: transportA! });
      const busB = new DispatchBoardEventBus({ replicaId: 'inst-b', transport: transportB! });

      const onA: DispatchBoardEvent[] = [];
      const onB: DispatchBoardEvent[] = [];
      busA.subscribe('t1', '2026-05-20', (e) => onA.push(e));
      busB.subscribe('t1', '2026-05-20', (e) => onB.push(e));

      // Let both subscriber connections finish SUBSCRIBE before publishing.
      await new Promise((r) => setTimeout(r, 200));

      busA.publishBoardUpdated('t1', '2026-05-20', 'rev-redis-1');
      await waitFor(() => onB.length >= 1);
      expect(onB[0]).toEqual({
        type: 'board_updated',
        date: '2026-05-20',
        boardRevision: 'rev-redis-1',
      });

      // Give A's own Redis echo a beat — it must be dropped (still one).
      await new Promise((r) => setTimeout(r, 200));
      expect(onA).toHaveLength(1);
    } finally {
      await transportA!.close();
      await transportB!.close();
    }
  });
});
