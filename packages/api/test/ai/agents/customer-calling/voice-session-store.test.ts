import { describe, it, expect, afterEach, vi } from 'vitest';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';

describe('VoiceSessionStore', () => {
  const stores: VoiceSessionStore[] = [];

  afterEach(() => {
    while (stores.length) stores.pop()!.dispose();
  });

  function newStore(opts?: ConstructorParameters<typeof VoiceSessionStore>[0]) {
    const s = new VoiceSessionStore({ startInterval: false, ...opts });
    stores.push(s);
    return s;
  }

  it('creates and retrieves a session by id', () => {
    const store = newStore();
    const session = store.create('tenant-a', 'inapp');
    expect(session.tenantId).toBe('tenant-a');
    expect(session.channel).toBe('inapp');
    expect(store.get(session.id)?.id).toBe(session.id);
  });

  it('reaps idle sessions past TTL', () => {
    const store = newStore({ idleTtlMs: 1000 });
    const session = store.create('t', 'inapp');
    // Pretend last activity was 2s ago
    session.lastActivityAt = new Date(Date.now() - 2000);
    const reaped = store.reapIdle();
    expect(reaped).toContain(session.id);
    expect(store.peek(session.id)).toBeUndefined();
  });

  it('does not reap sessions that are still fresh', () => {
    const store = newStore({ idleTtlMs: 60_000 });
    const session = store.create('t', 'inapp');
    const reaped = store.reapIdle();
    expect(reaped).not.toContain(session.id);
    expect(store.peek(session.id)).toBeDefined();
  });

  it('isolates sessions across tenants', () => {
    const store = newStore();
    const a = store.create('tenant-a', 'inapp');
    const b = store.create('tenant-b', 'inapp');
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(store.size()).toBe(2);
  });

  it('liveCount() excludes ended sessions; size() retains them (Codex P2 drain)', () => {
    const store = newStore();
    const a = store.create('tenant-a', 'inapp');
    store.create('tenant-b', 'inapp');
    expect(store.size()).toBe(2);
    expect(store.liveCount()).toBe(2);
    // An ended session stays in the map for post-call lookups (size stays 2)
    // but must NOT count toward the SIGTERM drain wait.
    a.ended = true;
    expect(store.size()).toBe(2);
    expect(store.liveCount()).toBe(1);
  });

  it('delete removes the session', () => {
    const store = newStore();
    const s = store.create('t', 'inapp');
    store.delete(s.id);
    expect(store.peek(s.id)).toBeUndefined();
  });

  // ── U8: mid-call transcript persistence (R8) ──────────────────────────────

  describe('mid-call transcript persistence', () => {
    const CALL_SID = 'CA00000000000000000000000000000001';

    function recordingRepo(opts: { reject?: Error } = {}) {
      const recordTurn = vi.fn(async (input: unknown) => {
        if (opts.reject) throw opts.reject;
        return input as never;
      });
      const markReplyAudio = vi.fn(async () => 1);
      return { repo: { recordTurn, markReplyAudio }, recordTurn };
    }

    it('persists each appended turn keyed by tenant + callSid + sessionId with the append-time index', async () => {
      const { repo, recordTurn } = recordingRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });

      store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'my AC is broken' });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'when did it start' });
      await Promise.resolve();

      expect(recordTurn).toHaveBeenCalledTimes(3);
      expect(recordTurn.mock.calls.map(([input]) => input)).toEqual([
        { tenantId: 'tenant-a', callSid: CALL_SID, sessionId: session.id, turnIndex: 0, speaker: 'agent', text: 'hi' },
        { tenantId: 'tenant-a', callSid: CALL_SID, sessionId: session.id, turnIndex: 1, speaker: 'caller', text: 'my AC is broken' },
        { tenantId: 'tenant-a', callSid: CALL_SID, sessionId: session.id, turnIndex: 2, speaker: 'agent', text: 'when did it start' },
      ]);
      // No recording id yet — the voice_recordings row does not exist mid-call.
      expect(recordTurn.mock.calls.every(([input]) => !('voiceRecordingId' in (input as object)))).toBe(true);
    });

    it('does not persist for an in-app session (no callSid)', async () => {
      const { repo, recordTurn } = recordingRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'inapp');
      store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });
      await Promise.resolve();
      expect(recordTurn).not.toHaveBeenCalled();
      expect(store.get(session.id)?.transcript).toEqual(['caller: hello']);
    });

    it('skips an empty utterance but still reserves its index for the next turn', async () => {
      const { repo, recordTurn } = recordingRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' });
      store.appendTranscript(session.id, { speaker: 'caller', text: '   ' });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'still there?' });
      await Promise.resolve();
      expect(recordTurn.mock.calls.map(([input]) => (input as { turnIndex: number }).turnIndex)).toEqual([0, 2]);
    });

    it('a failing repo write never throws into the call path: the in-memory transcript still grows and the error is logged', async () => {
      const { repo, recordTurn } = recordingRepo({ reject: new Error('db down') });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const store = newStore({ callTranscriptTurnRepo: repo });
        const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });

        expect(() => store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' })).not.toThrow();
        expect(() => store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' })).not.toThrow();
        // Let the rejected promises settle.
        await new Promise((resolve) => setImmediate(resolve));

        expect(recordTurn).toHaveBeenCalledTimes(2);
        expect(store.get(session.id)?.transcript).toEqual(['agent: hi', 'caller: hello']);
        expect(errorSpy).toHaveBeenCalledTimes(2);
        expect(String(errorSpy.mock.calls[0][0])).toContain('transcript');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('a repo that throws synchronously is contained the same way', async () => {
      const repo = {
        recordTurn: vi.fn(() => {
          throw new Error('sync boom');
        }),
      };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const store = newStore({ callTranscriptTurnRepo: repo as never });
        const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
        expect(() => store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' })).not.toThrow();
        await new Promise((resolve) => setImmediate(resolve));
        expect(store.get(session.id)?.transcript).toEqual(['agent: hi']);
        expect(errorSpy).toHaveBeenCalledTimes(1);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('no repo injected → append is purely in-memory (existing behaviour)', () => {
      const store = newStore();
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' });
      expect(store.get(session.id)?.transcript).toEqual(['agent: hi']);
    });
  });

  // ── U1: caller-turn timing + reply-audio stamps ───────────────────────────

  describe('reply-gap timing (U1)', () => {
    const CALL_SID = 'CA00000000000000000000000000000002';
    const settle = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

    function timedRepo(opts: { markResult?: number; recordGate?: Promise<void> } = {}) {
      const order: string[] = [];
      const recordTurn = vi.fn(async (input: unknown) => {
        if (opts.recordGate) await opts.recordGate;
        order.push('recordTurn');
        return input as never;
      });
      const markReplyAudio = vi.fn(async (_input: unknown) => {
        order.push('markReplyAudio');
        return opts.markResult ?? 1;
      });
      return { repo: { recordTurn, markReplyAudio }, recordTurn, markReplyAudio, order };
    }

    it('hands the pending timing to the next CALLER append only, computing endpointDelayMs', async () => {
      const { repo, recordTurn } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      const lastWordAt = new Date(1_000);
      const sttFinalAt = new Date(1_850);

      store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' });
      store.beginCallerTurnTiming(session.id, { transport: 'realtime', sttFinalAt, lastWordAt });
      // An agent append in between must not consume the timing.
      store.appendTranscript(session.id, { speaker: 'agent', text: 'one moment' });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'my AC is broken' });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'and it is hot' });
      await settle();

      const inputs = recordTurn.mock.calls.map(([input]) => input as Record<string, unknown>);
      expect(inputs[0]).not.toHaveProperty('transport');
      expect(inputs[1]).not.toHaveProperty('sttFinalAt');
      expect(inputs[2]).toMatchObject({
        speaker: 'caller',
        transport: 'realtime',
        sttFinalAt,
        lastWordAt,
        endpointDelayMs: 850,
      });
      // Consumed by the first caller append: the next one carries nothing.
      expect(inputs[3]).not.toHaveProperty('transport');
      expect(inputs[3]).not.toHaveProperty('endpointDelayMs');
    });

    it('a Gather turn carries transport and sttFinalAt but no last word or endpoint delay', async () => {
      const { repo, recordTurn } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      const sttFinalAt = new Date(5_000);

      store.beginCallerTurnTiming(session.id, { transport: 'gather', sttFinalAt });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });
      await settle();

      const input = recordTurn.mock.calls[0][0] as Record<string, unknown>;
      expect(input).toMatchObject({ transport: 'gather', sttFinalAt });
      expect(input).not.toHaveProperty('lastWordAt');
      expect(input).not.toHaveProperty('endpointDelayMs');
    });

    it('no timing begun → a caller append records none of the new fields', async () => {
      const { repo, recordTurn } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });
      await settle();
      expect(Object.keys(recordTurn.mock.calls[0][0] as object).sort()).toEqual(
        ['callSid', 'sessionId', 'speaker', 'tenantId', 'text', 'turnIndex'],
      );
      expect(store.peek(session.id)?.replyTiming).toBeUndefined();
    });

    it('exposes the reply anchors of the latest caller turn and keeps one retained promise', async () => {
      const { repo } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      const sttFinalAt = new Date(2_000);
      const lastWordAt = new Date(1_200);

      store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' });
      store.beginCallerTurnTiming(session.id, { transport: 'realtime', sttFinalAt, lastWordAt });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'first' });
      expect(store.peek(session.id)?.replyTiming).toEqual({ turnIndex: 1, sttFinalAt, lastWordAt });
      expect([...store.peek(session.id)!.pendingTurnPersist.keys()]).toEqual([1]);

      store.beginCallerTurnTiming(session.id, { transport: 'realtime', sttFinalAt: new Date(9_000) });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'ok' });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'second' });
      expect([...store.peek(session.id)!.pendingTurnPersist.keys()]).toEqual([3]);
      await settle();
    });

    it('markReplyAudio chains behind a still-pending recordTurn, never racing the INSERT', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { repo, markReplyAudio, order } = timedRepo({ recordGate: gate });
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.beginCallerTurnTiming(session.id, { transport: 'realtime', sttFinalAt: new Date(1) });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });

      const stamped = store.markReplyAudio(session.id, { turnIndex: 0, firstAudioAt: new Date(2), replyGapMs: 900 });
      await settle();
      expect(markReplyAudio).not.toHaveBeenCalled();

      release();
      await stamped;
      expect(order).toEqual(['recordTurn', 'markReplyAudio']);
      expect(markReplyAudio).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        callSid: CALL_SID,
        sessionId: session.id,
        turnIndex: 0,
        firstAudioAt: new Date(2),
        replyGapMs: 900,
      });
    });

    it('markReplyAudio stamps immediately when the insert settled long ago (retained promise)', async () => {
      const { repo, markReplyAudio } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });
      await settle();
      await store.markReplyAudio(session.id, { turnIndex: 0, firstAudibleAt: new Date(3) });
      expect(markReplyAudio).toHaveBeenCalledTimes(1);
    });

    it('an in-app session or an unknown session is a silent no-op', async () => {
      const { repo, markReplyAudio } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      await expect(store.markReplyAudio('missing', { turnIndex: 0 })).resolves.toBeUndefined();
      const inapp = store.create('tenant-a', 'inapp');
      await store.markReplyAudio(inapp.id, { turnIndex: 0, firstAudioAt: new Date() });
      expect(markReplyAudio).not.toHaveBeenCalled();
    });

    it('a zero-row update increments voice_reply_stamp_lost_total and logs the key', async () => {
      const { voiceReplyStampLostTotal } = await import('../../../../src/monitoring/metrics');
      voiceReplyStampLostTotal.reset();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { repo } = timedRepo({ markResult: 0 });
        const store = newStore({ callTranscriptTurnRepo: repo });
        const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
        store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });
        await store.markReplyAudio(session.id, { turnIndex: 0, firstAudioAt: new Date() });

        const snap = await voiceReplyStampLostTotal.get();
        expect(snap.values[0].value).toBe(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][1]).toMatchObject({ callSid: CALL_SID, turnIndex: 0 });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a rejecting markReplyAudio never rejects into the caller', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const repo = {
          recordTurn: vi.fn(async (input: unknown) => input as never),
          markReplyAudio: vi.fn(async () => {
            throw new Error('db down');
          }),
        };
        const store = newStore({ callTranscriptTurnRepo: repo as never });
        const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
        store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });
        await expect(store.markReplyAudio(session.id, { turnIndex: 0, firstAudioAt: new Date() })).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledTimes(1);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('delete clears the retained persist promises', async () => {
      const { repo } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });
      const map = session.pendingTurnPersist;
      expect(map.size).toBe(1);
      store.delete(session.id);
      expect(map.size).toBe(0);
      await settle();
    });
  });
});
