import { describe, it, expect, afterAll } from 'vitest';
import { createRedisVoiceEventTransport } from '../../../../src/ai/agents/customer-calling/redis-voice-event-transport';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import type { VoiceSessionEvent } from '../../../../src/ai/agents/customer-calling/voice-session-store';

/**
 * Two real VoiceSessionStores (simulating two replicas) sharing one Redis,
 * proving the pub/sub mirror: an event emitted on replica A is observed by
 * replica B's global sink, while A's own listener fires exactly once (the
 * Redis echo of A's own message is dropped by self-origin dedup).
 *
 * Gated on TEST_REDIS_URL — skipped in the sandbox (no Redis), runs in CI.
 */
const REDIS_URL = process.env.TEST_REDIS_URL;
const describeRedis = REDIS_URL ? describe : describe.skip;

/** Poll until `cond()` is true or the deadline passes (pub/sub is async). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describeRedis('VoiceSessionStore two-instance Redis fan-out (U3d)', () => {
  const stores: VoiceSessionStore[] = [];

  afterAll(() => {
    for (const s of stores) s.dispose();
  });

  it('B observes A’s event; A’s own listener fires exactly once', async () => {
    const transportA = await createRedisVoiceEventTransport(REDIS_URL);
    const transportB = await createRedisVoiceEventTransport(REDIS_URL);
    expect(transportA).not.toBeNull();
    expect(transportB).not.toBeNull();

    const storeA = new VoiceSessionStore({
      transport: transportA!,
      replicaId: 'inst-a',
      startInterval: false,
    });
    const storeB = new VoiceSessionStore({
      transport: transportB!,
      replicaId: 'inst-b',
      startInterval: false,
    });
    stores.push(storeA, storeB);

    const onA: VoiceSessionEvent[] = [];
    const onB: VoiceSessionEvent[] = [];
    storeA.subscribeGlobal((e) => onA.push(e));
    storeB.subscribeGlobal((e) => onB.push(e));

    // Let both subscriber connections finish SUBSCRIBE before publishing.
    await new Promise((r) => setTimeout(r, 200));

    const session = storeA.create('tenant-1', 'telephony', { callSid: 'CA-xyz' });
    const evt: VoiceSessionEvent = { type: 'ended', reason: 'hangup' };
    session.events.emit('voice-event', evt);

    // B receives it via the Redis mirror.
    await waitFor(() => onB.length >= 1);
    expect(onB).toContainEqual(evt);

    // A's listener fired once synchronously (local emit). Give the Redis echo a
    // beat to arrive — it must be dropped by self-origin dedup, so still one.
    await new Promise((r) => setTimeout(r, 200));
    expect(onA.filter((e) => e === evt || (e.type === 'ended' && e.reason === 'hangup'))).toHaveLength(1);
  });
});
