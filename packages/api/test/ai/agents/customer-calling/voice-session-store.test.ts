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
      const redactCardNumberTurns = vi.fn(async () => 0);
      return { repo: { recordTurn, markReplyAudio, redactCardNumberTurns }, recordTurn };
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

    /** Append a caller line carrying a unique turn key, as the realtime adapter does. */
    const appendKeyed = (store: VoiceSessionStore, sessionId: string, turnKey: string): void =>
      store.appendTranscript(sessionId, {
        speaker: 'caller',
        text: `line ${turnKey}`,
        timing: { transport: 'realtime', turnKey, sttFinalAt: new Date(1) },
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
      const redactCardNumberTurns = vi.fn(async () => 0);
      return { repo: { recordTurn, markReplyAudio, redactCardNumberTurns }, recordTurn, markReplyAudio, order };
    }

    it('stamps the timing carried on a CALLER append only, computing endpointDelayMs', async () => {
      const { repo, recordTurn } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      const lastWordAt = new Date(1_000);
      const sttFinalAt = new Date(1_850);

      store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' });
      // A timing on an agent line is ignored: only caller rows are stamped.
      store.appendTranscript(session.id, {
        speaker: 'agent',
        text: 'one moment',
        timing: { transport: 'realtime', sttFinalAt: new Date(7) },
      });
      store.appendTranscript(session.id, {
        speaker: 'caller',
        text: 'my AC is broken',
        timing: { transport: 'realtime', sttFinalAt, lastWordAt },
      });
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
      // The next caller append carried no timing, so its row has none.
      expect(inputs[3]).not.toHaveProperty('transport');
      expect(inputs[3]).not.toHaveProperty('endpointDelayMs');
    });

    it('a Gather turn carries transport and sttFinalAt but no last word or endpoint delay', async () => {
      const { repo, recordTurn } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      const sttFinalAt = new Date(5_000);

      store.appendTranscript(session.id, {
        speaker: 'caller',
        text: 'hello',
        timing: { transport: 'gather', sttFinalAt },
      });
      await settle();

      const input = recordTurn.mock.calls[0][0] as Record<string, unknown>;
      expect(input).toMatchObject({ transport: 'gather', sttFinalAt });
      expect(input).not.toHaveProperty('lastWordAt');
      expect(input).not.toHaveProperty('endpointDelayMs');
    });

    it('a caller append with no timing records none of the new fields', async () => {
      const { repo, recordTurn } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'hello' });
      await settle();
      expect(Object.keys(recordTurn.mock.calls[0][0] as object).sort()).toEqual(
        ['callSid', 'sessionId', 'speaker', 'tenantId', 'text', 'turnIndex'],
      );
      expect(store.peek(session.id)?.replyTimings).toEqual([]);
    });

    it('exposes the reply anchors of the recent caller turns and retains only the last few promises', async () => {
      const { repo } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      const sttFinalAt = new Date(2_000);
      const lastWordAt = new Date(1_200);

      store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' });
      store.appendTranscript(session.id, {
        speaker: 'caller',
        text: 'first',
        timing: { transport: 'realtime', sttFinalAt, lastWordAt },
      });
      expect(store.peek(session.id)?.replyTimings).toEqual([{ turnIndex: 1, sttFinalAt, lastWordAt }]);
      expect([...store.peek(session.id)!.pendingTurnPersist.keys()]).toEqual([1]);

      // Five more caller turns: only the last four anchors / promises survive.
      for (let i = 0; i < 5; i++) {
        store.appendTranscript(session.id, { speaker: 'agent', text: 'ok' });
        store.appendTranscript(session.id, {
          speaker: 'caller',
          text: `more ${i}`,
          timing: { transport: 'realtime', sttFinalAt: new Date(9_000 + i) },
        });
      }
      const kept = store.peek(session.id)!;
      expect(kept.replyTimings.map((t) => t.turnIndex)).toEqual([5, 7, 9, 11]);
      expect([...kept.pendingTurnPersist.keys()]).toEqual([5, 7, 9, 11]);
      await settle();
    });

    it('finals that append out of arrival order: each row carries its OWN timing', async () => {
      const { repo, recordTurn } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      // "habla español" arrived first but waits behind the session lock in
      // switchLanguage(); the later final's turn queues and appends before it.
      const switchFinal = { transport: 'realtime' as const, sttFinalAt: new Date(1_000), lastWordAt: new Date(800) };
      const laterFinal = { transport: 'realtime' as const, sttFinalAt: new Date(1_500), lastWordAt: new Date(1_400) };

      store.appendTranscript(session.id, { speaker: 'agent', text: 'one moment' });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'my AC is broken', timing: laterFinal });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'habla español', timing: switchFinal });
      await settle();

      const callerRows = recordTurn.mock.calls
        .map(([input]) => input as Record<string, unknown>)
        .filter((i) => i.speaker === 'caller');
      expect(callerRows[0]).toMatchObject({
        turnIndex: 1,
        text: 'my AC is broken',
        sttFinalAt: laterFinal.sttFinalAt,
        lastWordAt: laterFinal.lastWordAt,
        endpointDelayMs: 100,
      });
      expect(callerRows[1]).toMatchObject({
        turnIndex: 2,
        text: 'habla español',
        sttFinalAt: switchFinal.sttFinalAt,
        lastWordAt: switchFinal.lastWordAt,
        endpointDelayMs: 200,
      });
      expect(store.peek(session.id)?.replyTimings).toEqual([
        { turnIndex: 1, sttFinalAt: laterFinal.sttFinalAt, lastWordAt: laterFinal.lastWordAt },
        { turnIndex: 2, sttFinalAt: switchFinal.sttFinalAt, lastWordAt: switchFinal.lastWordAt },
      ]);
    });

    it('markReplyAudio chains behind a still-pending recordTurn, never racing the INSERT', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { repo, markReplyAudio, order } = timedRepo({ recordGate: gate });
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, {
        speaker: 'caller',
        text: 'hello',
        timing: { transport: 'realtime', turnKey: 'k0', sttFinalAt: new Date(1) },
      });

      const stamped = store.markReplyAudio(session.id, { turnKey: 'k0', firstAudioAt: new Date(2), replyGapMs: 900 });
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
      appendKeyed(store, session.id, 'k0');
      await settle();
      await store.markReplyAudio(session.id, { turnKey: 'k0', firstAudibleAt: new Date(3) });
      expect(markReplyAudio).toHaveBeenCalledTimes(1);
    });

    it('markReplyAudio stamps by the row id recordTurn returned, not the (possibly renumbered) index', async () => {
      const recordTurn = vi.fn(async (input: unknown) => ({ ...(input as object), id: 'row-uuid-1' }) as never);
      const markReplyAudio = vi.fn(async (_input: unknown) => 1);
      const store = newStore({
        callTranscriptTurnRepo: { recordTurn, markReplyAudio, redactCardNumberTurns: vi.fn(async () => 0) },
      });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      appendKeyed(store, session.id, 'k0');

      await store.markReplyAudio(session.id, { turnKey: 'k0', firstAudioAt: new Date(2) });
      expect(markReplyAudio).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        id: 'row-uuid-1',
        callSid: CALL_SID,
        sessionId: session.id,
        turnIndex: 0,
        firstAudioAt: new Date(2),
      });
    });

    it('a failed insert resolves no id: the stamp falls back to the mid-call key', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const recordTurn = vi.fn(async () => {
          throw new Error('insert failed');
        });
        const markReplyAudio = vi.fn(async (_input: unknown) => 0);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
          const store = newStore({ callTranscriptTurnRepo: { recordTurn, markReplyAudio } as never });
          const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
          appendKeyed(store, session.id, 'k0');
          await store.markReplyAudio(session.id, { turnKey: 'k0', firstAudioAt: new Date(2) });
          expect(markReplyAudio.mock.calls[0][0]).not.toHaveProperty('id');
          expect(markReplyAudio.mock.calls[0][0]).toMatchObject({ callSid: CALL_SID, turnIndex: 0 });
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('an in-app session or an unknown session is a silent no-op', async () => {
      const { repo, markReplyAudio } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      await expect(store.markReplyAudio('missing', { turnKey: 'k0' })).resolves.toBeUndefined();
      const inapp = store.create('tenant-a', 'inapp');
      await store.markReplyAudio(inapp.id, { turnKey: 'k0', firstAudioAt: new Date() });
      expect(markReplyAudio).not.toHaveBeenCalled();
      expect(inapp.pendingReplyStamps.size).toBe(0); // nothing to retain for a session that never persists
    });

    it('a zero-row update increments voice_reply_stamp_lost_total and logs the key', async () => {
      const { voiceReplyStampLostTotal } = await import('../../../../src/monitoring/metrics');
      voiceReplyStampLostTotal.reset();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { repo } = timedRepo({ markResult: 0 });
        const store = newStore({ callTranscriptTurnRepo: repo });
        const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
        appendKeyed(store, session.id, 'k0');
        await store.markReplyAudio(session.id, { turnKey: 'k0', firstAudioAt: new Date() });

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
        appendKeyed(store, session.id, 'k0');
        await expect(store.markReplyAudio(session.id, { turnKey: 'k0', firstAudioAt: new Date() })).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledTimes(1);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('resolves a stamp to the row carrying its key, whatever index that row took', async () => {
      const { repo, markReplyAudio } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' });
      appendKeyed(store, session.id, 'ka');
      store.appendTranscript(session.id, { speaker: 'agent', text: 'ok' });
      appendKeyed(store, session.id, 'kb');

      await store.markReplyAudio(session.id, { turnKey: 'kb', firstAudioAt: new Date(2) });
      await store.markReplyAudio(session.id, { turnKey: 'ka', firstAudioAt: new Date(3) });
      expect(markReplyAudio.mock.calls.map(([i]) => (i as { turnIndex: number }).turnIndex)).toEqual([3, 1]);
      expect(session.pendingReplyStamps.size).toBe(0);
    });

    it('retains a stamp whose caller row is not appended yet and writes it, merged, when the row appears', async () => {
      const { repo, markReplyAudio, order } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });

      // Both arrive before the row exists (a filler ack, then the first-real enqueue).
      await store.markReplyAudio(session.id, { turnKey: 'late', firstAudibleAt: new Date(10) });
      await store.markReplyAudio(session.id, {
        turnKey: 'late',
        firstAudibleAt: new Date(99), // a later duplicate loses: first stamp for a field wins
        firstAudioEnqueuedAt: new Date(20),
      });
      await settle();
      expect(markReplyAudio).not.toHaveBeenCalled();
      expect(session.pendingReplyStamps.get('late')).toHaveLength(2);

      store.appendTranscript(session.id, { speaker: 'agent', text: 'hi' });
      appendKeyed(store, session.id, 'late');
      await settle();

      expect(order).toEqual(['recordTurn', 'recordTurn', 'markReplyAudio']); // chained behind the INSERT
      expect(markReplyAudio).toHaveBeenCalledTimes(1);
      expect(markReplyAudio).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        callSid: CALL_SID,
        sessionId: session.id,
        turnIndex: 1,
        firstAudibleAt: new Date(10),
        firstAudioEnqueuedAt: new Date(20),
      });
      expect(session.pendingReplyStamps.size).toBe(0);

      // Once the row exists a stamp goes straight through.
      await store.markReplyAudio(session.id, { turnKey: 'late', firstAudioAt: new Date(30), replyGapMs: 700 });
      expect(markReplyAudio).toHaveBeenCalledTimes(2);
    });

    it('keeps retained stamps per key: another key\'s row flushes only its own', async () => {
      const { repo, markReplyAudio } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      await store.markReplyAudio(session.id, { turnKey: 'kb', firstAudibleAt: new Date(2) });

      appendKeyed(store, session.id, 'ka');
      await settle();
      expect(markReplyAudio).not.toHaveBeenCalled();
      expect([...session.pendingReplyStamps.keys()]).toEqual(['kb']);

      appendKeyed(store, session.id, 'kb');
      await settle();
      expect(markReplyAudio).toHaveBeenCalledWith(expect.objectContaining({ turnIndex: 1, firstAudibleAt: new Date(2) }));
    });

    it('drops the oldest key\'s stamps beyond the last four keys, warning once for it', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { repo, markReplyAudio } = timedRepo();
        const store = newStore({ callTranscriptTurnRepo: repo });
        const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
        const { voiceReplyStampLostTotal } = await import('../../../../src/monitoring/metrics');
        voiceReplyStampLostTotal.reset();

        for (const key of ['k1', 'k2', 'k3', 'k4']) {
          await store.markReplyAudio(session.id, { turnKey: key, firstAudibleAt: new Date(1) });
        }
        // A second stamp for an already-held key does not count as a newer key.
        await store.markReplyAudio(session.id, { turnKey: 'k1', firstAudioEnqueuedAt: new Date(2) });
        expect(warnSpy).not.toHaveBeenCalled();
        expect([...session.pendingReplyStamps.keys()]).toEqual(['k1', 'k2', 'k3', 'k4']);

        await store.markReplyAudio(session.id, { turnKey: 'k5', firstAudibleAt: new Date(1) });
        expect([...session.pendingReplyStamps.keys()]).toEqual(['k2', 'k3', 'k4', 'k5']);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][1]).toMatchObject({ callSid: CALL_SID, turnKey: 'k1' });
        // "a row was deleted underneath" is a different failure: its counter stays untouched.
        expect((await voiceReplyStampLostTotal.get()).values.every((v) => v.value === 0)).toBe(true);

        // The dropped key's row appearing later flushes nothing; a held key still flushes.
        appendKeyed(store, session.id, 'k1');
        appendKeyed(store, session.id, 'k2');
        await settle();
        expect(markReplyAudio).toHaveBeenCalledTimes(1);
        expect(markReplyAudio).toHaveBeenCalledWith(expect.objectContaining({ turnIndex: 1 }));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('delete clears the retained reply stamps', async () => {
      const { repo } = timedRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      await store.markReplyAudio(session.id, { turnKey: 'k1', firstAudibleAt: new Date(1) });
      expect(session.pendingReplyStamps.size).toBe(1);
      store.delete(session.id);
      expect(session.pendingReplyStamps.size).toBe(0);
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

  // ── PRIV-3: a card number split across caller turns ───────────────────────

  describe('a card number split across caller turns (PRIV-3)', () => {
    const CALL_SID = 'CA00000000000000000000000000000009';
    const MARKER = '[card number]';
    const AGENT_ON_CARD = "Sorry, I can't take card numbers over the phone.";
    const settle = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

    function splitRepo() {
      const recordTurn = vi.fn(async (input: { turnIndex: number }) => ({ id: `row-${input.turnIndex}` }) as never);
      const markReplyAudio = vi.fn(async () => 1);
      const redactCardNumberTurns = vi.fn(async (input: { turns: ReadonlyArray<unknown> }) => input.turns.length);
      return { repo: { recordTurn, markReplyAudio, redactCardNumberTurns }, recordTurn, redactCardNumberTurns };
    }

    it('rewrites all three caller turns when the third completes a card, in memory at once and in one repository call', async () => {
      const { repo, recordTurn, redactCardNumberTurns } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });

      store.appendTranscript(session.id, { speaker: 'agent', text: 'how can I help' });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'my card is 4111 1111' });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'go on' });
      store.appendTranscript(session.id, { speaker: 'caller', text: '1111' });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'and the rest?' });
      store.appendTranscript(session.id, { speaker: 'caller', text: '1111 thanks' });

      // Synchronously: the next prompt built from the transcript never sees it.
      expect(session.transcript).toEqual([
        'agent: how can I help',
        `caller: my card is ${MARKER}`,
        'agent: go on',
        `caller: ${MARKER}`,
        'agent: and the rest?',
        `caller: ${MARKER} thanks`,
      ]);

      await session.cardRedactionWrites;
      // The completing turn's row is inserted already rewritten.
      expect(recordTurn.mock.calls.at(-1)![0]).toMatchObject({ turnIndex: 5, text: `${MARKER} thanks` });
      expect(redactCardNumberTurns).toHaveBeenCalledTimes(1);
      expect(redactCardNumberTurns).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        callSid: CALL_SID,
        sessionId: session.id,
        actorId: 'voice-session-store',
        turns: [
          { id: 'row-1', turnIndex: 1, text: `my card is ${MARKER}` },
          { id: 'row-3', turnIndex: 3, text: MARKER },
          { id: 'row-5', turnIndex: 5, text: `${MARKER} thanks` },
        ],
      });
    });

    it('returns the text each turn was stored as, and the earlier turns a completing turn rewrote', () => {
      const store = newStore();
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      expect(store.appendTranscript(session.id, { speaker: 'agent', text: 'how can I help' })).toEqual({
        text: 'how can I help',
        rewrittenTurnIndexes: [],
      });
      expect(store.appendTranscript(session.id, { speaker: 'caller', text: 'my card is 4111 1111' })).toEqual({
        text: 'my card is 4111 1111',
        rewrittenTurnIndexes: [],
      });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'go on' });
      expect(store.appendTranscript(session.id, { speaker: 'caller', text: '1111 1111 thanks' })).toEqual({
        text: `${MARKER} thanks`,
        rewrittenTurnIndexes: [1],
      });
      // An unknown session stores nothing and rewrites nothing.
      expect(store.appendTranscript('no-such-session', { speaker: 'caller', text: '1111' })).toEqual({
        text: '1111',
        rewrittenTurnIndexes: [],
      });
    });

    it("rewrites the caller's words an earlier turn already handed on: the FSM context and the held requests", () => {
      const store = newStore();
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      const first = 'book a visit, my card is 4111 1111 1111';
      store.appendTranscript(session.id, { speaker: 'caller', text: first });
      // What the first turn handed on before anything could tell it held part
      // of a card: the classified request, its entities, and a held request.
      session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: '+15125550100', to: '+15125550999', tenantId: 'tenant-a' });
      session.machine.dispatch({ type: 'greeted_ok' });
      session.machine.dispatch({ type: 'caller_known', customerId: 'cust-41111111' });
      session.machine.dispatch({
        type: 'intent_classified',
        intentType: 'create_appointment',
        entities: { notes: 'card 4111 1111 1111 on file', serviceType: 'tune-up', jobId: 'job-1111' },
        confidence: 0.95,
        utterance: first,
      });
      session.serviceAreaCheck = { heldUtterance: first, reasks: 0 };
      session.callerIdentityCheck = { heldUtterance: first, accountName: 'Dana Reyes', reasks: 0 };
      session.rebookOffer = { heldUtterance: first, cancelledAppointmentId: 'appt-1', entities: {}, confidence: 0.9 };

      store.appendTranscript(session.id, { speaker: 'caller', text: '1111' });

      const rewrittenFirst = `book a visit, my card is ${MARKER}`;
      const context = session.machine.currentContext;
      expect(context.lastUtterance).toBe(rewrittenFirst);
      expect(context.extractedEntities).toEqual({
        notes: `card ${MARKER} on file`,
        serviceType: 'tune-up',
        // Ids are never rewritten, whatever digits they hold.
        jobId: 'job-1111',
      });
      expect(context.customerId).toBe('cust-41111111');
      expect(session.serviceAreaCheck.heldUtterance).toBe(rewrittenFirst);
      expect(session.callerIdentityCheck.heldUtterance).toBe(rewrittenFirst);
      expect(session.rebookOffer.heldUtterance).toBe(rewrittenFirst);
    });

    // The agent's confirm readback renders what the classifier took from the
    // first turn: once the next turn shows those digits were part of a card,
    // the readback holds them too, in the transcript every later prompt is
    // built from and in its stored row.
    it("rewrites the agent's readback of a part of the card, in memory at once and in the same repository call", async () => {
      const { repo, redactCardNumberTurns } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'add a note, the card on file is 4111 1111 1111' });
      store.appendTranscript(session.id, {
        speaker: 'agent',
        text: 'Just to confirm: a note, the card on file is 4111-1111-1111. Is that right?',
      });
      expect(store.appendTranscript(session.id, { speaker: 'caller', text: "1111. Yes, that's right." })).toEqual({
        text: `${MARKER}. Yes, that's right.`,
        rewrittenTurnIndexes: [0, 1],
      });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'Done.' });
      expect(session.transcript).toEqual([
        `caller: add a note, the card on file is ${MARKER}`,
        `agent: Just to confirm: a note, the card on file is ${MARKER}. Is that right?`,
        `caller: ${MARKER}. Yes, that's right.`,
        'agent: Done.',
      ]);
      await session.cardRedactionWrites;
      expect(redactCardNumberTurns).toHaveBeenCalledTimes(1);
      expect(redactCardNumberTurns).toHaveBeenCalledWith(
        expect.objectContaining({
          turns: [
            { id: 'row-0', turnIndex: 0, text: `add a note, the card on file is ${MARKER}` },
            {
              id: 'row-1',
              turnIndex: 1,
              speaker: 'agent',
              text: `Just to confirm: a note, the card on file is ${MARKER}. Is that right?`,
            },
            { id: 'row-2', turnIndex: 2, text: `${MARKER}. Yes, that's right.` },
          ],
        }),
      );
    });

    // A caller turn that was nothing but "4111" is replaced wherever its
    // digits are read as one number, never inside another one ("84111").
    it('rewrites only whole numbers in the captured words, the held rebook entities and the last spoken line included', () => {
      const store = newStore();
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'agent', text: AGENT_ON_CARD });
      store.appendTranscript(session.id, { speaker: 'caller', text: '4111' });
      session.machine.dispatch({ type: 'incoming_call', callSid: CALL_SID, from: '+15125550100', to: '+15125550999', tenantId: 'tenant-a' });
      session.machine.dispatch({ type: 'greeted_ok' });
      session.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
      session.machine.dispatch({
        type: 'intent_classified',
        intentType: 'create_appointment',
        entities: { zip: '84111', callbackPhone: '602 555 4111', notes: 'card 4111' },
        confidence: 0.95,
        utterance: '4111',
      });
      session.rebookOffer = {
        heldUtterance: 'rebook it, the card is 4111',
        cancelledAppointmentId: 'appt-1',
        entities: { zip: '84111', notes: 'paid with 4111' },
        confidence: 0.9,
      };
      session.lastOperatorTurn = {
        normalizedText: '4111',
        at: 0,
        stateBefore: 'intent_classify',
        stateAfter: 'intent_confirm',
        lastSpoken: 'You said 4111?',
      };
      for (const text of ['1111', '1111', '1111']) store.appendTranscript(session.id, { speaker: 'caller', text });
      expect(session.transcript.slice(1)).toEqual(Array(4).fill(`caller: ${MARKER}`));

      const context = session.machine.currentContext;
      expect(context.lastUtterance).toBe(MARKER);
      expect(context.extractedEntities).toEqual({ zip: '84111', callbackPhone: '602 555 4111', notes: `card ${MARKER}` });
      expect(session.rebookOffer.heldUtterance).toBe(`rebook it, the card is ${MARKER}`);
      expect(session.rebookOffer.entities).toEqual({ zip: '84111', notes: `paid with ${MARKER}` });
      expect(session.lastOperatorTurn.normalizedText).toBe(MARKER);
      expect(session.lastOperatorTurn.lastSpoken).toBe(`You said ${MARKER}?`);
    });

    it('leaves the captured words alone when no earlier turn is rewritten', () => {
      const store = newStore();
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'gate code 4111' });
      session.serviceAreaCheck = { heldUtterance: 'gate code 4111', reasks: 0 };
      const contextBefore = session.machine.currentContext;
      store.appendTranscript(session.id, { speaker: 'caller', text: '1111' });
      expect(session.serviceAreaCheck.heldUtterance).toBe('gate code 4111');
      expect(session.machine.currentContext).toBe(contextBefore);
    });

    it('waits for the earlier rows to be inserted before rewriting them', async () => {
      const inserts: Array<() => void> = [];
      const recordTurn = vi.fn(
        (input: { turnIndex: number }) =>
          new Promise((resolve) => {
            inserts.push(() => resolve({ id: `row-${input.turnIndex}` }));
          }) as never,
      );
      const redactCardNumberTurns = vi.fn(async () => 2);
      const store = newStore({
        callTranscriptTurnRepo: { recordTurn, markReplyAudio: vi.fn(async () => 1), redactCardNumberTurns },
      });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'caller', text: '4111 1111' });
      store.appendTranscript(session.id, { speaker: 'caller', text: '1111 1111' });
      await settle();
      expect(redactCardNumberTurns).not.toHaveBeenCalled();
      for (const insert of inserts) insert();
      await session.cardRedactionWrites;
      expect(redactCardNumberTurns).toHaveBeenCalledWith(
        expect.objectContaining({
          turns: [
            { id: 'row-0', turnIndex: 0, text: MARKER },
            { id: 'row-1', turnIndex: 1, text: MARKER },
          ],
        }),
      );
    });

    it('never lets an agent turn join the window, nor rewrites one that repeats no part of the card', async () => {
      const { repo, redactCardNumberTurns } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      // With the agent's read-back joined this would be 4111 1111 1111 1111 1111.
      store.appendTranscript(session.id, { speaker: 'caller', text: '4111 1111' });
      store.appendTranscript(session.id, { speaker: 'agent', text: '1111 1111' });
      store.appendTranscript(session.id, { speaker: 'caller', text: '1111' });
      await session.cardRedactionWrites;
      expect(session.transcript).toEqual(['caller: 4111 1111', 'agent: 1111 1111', 'caller: 1111']);
      expect(redactCardNumberTurns).not.toHaveBeenCalled();

      // Caller turns on either side of an agent turn still join; the agent line stays.
      const other = store.create('tenant-a', 'telephony', { callSid: 'CA00000000000000000000000000000010' });
      store.appendTranscript(other.id, { speaker: 'caller', text: '4111 1111' });
      store.appendTranscript(other.id, { speaker: 'agent', text: 'go on, 1234' });
      store.appendTranscript(other.id, { speaker: 'caller', text: '1111 1111' });
      expect(other.transcript).toEqual([`caller: ${MARKER}`, 'agent: go on, 1234', `caller: ${MARKER}`]);
    });

    it('does not join a caller turn said more than a minute earlier', async () => {
      const { repo, redactCardNumberTurns } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(session.id, { speaker: 'caller', text: '4111 1111', ts: 1_000 });
      store.appendTranscript(session.id, { speaker: 'caller', text: '1111 1111', ts: 62_000 });
      await session.cardRedactionWrites;
      expect(session.transcript).toEqual(['caller: 4111 1111', 'caller: 1111 1111']);
      expect(redactCardNumberTurns).not.toHaveBeenCalled();
    });

    it('looks back over five caller turns, no further', async () => {
      const { repo } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      // The longest card (19 digits, Visa 4000 0000 0000 0000 006) read in its
      // 4-4-4-4-3 groups is five turns (a group per turn: the agent's line
      // before them mentions the card).
      const five = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(five.id, { speaker: 'agent', text: AGENT_ON_CARD });
      for (const text of ['4000', '0000', '0000', '0000', '006']) {
        store.appendTranscript(five.id, { speaker: 'caller', text });
      }
      expect(five.transcript).toEqual([`agent: ${AGENT_ON_CARD}`, ...Array(5).fill(`caller: ${MARKER}`)]);

      // A card over six turns: its leading 4 has left the window (and no card
      // read in its groups takes six turns).
      const six = store.create('tenant-a', 'telephony', { callSid: 'CA00000000000000000000000000000011' });
      const spoken = ['4', '1', '1', '1', '1111 1111', '1111'];
      for (const text of spoken) store.appendTranscript(six.id, { speaker: 'caller', text });
      expect(six.transcript).toEqual(spoken.map((t) => `caller: ${t}`));

      // Nor is a split no card is read in (1-3-4-4-4) stitched within five.
      const odd = store.create('tenant-a', 'telephony', { callSid: 'CA00000000000000000000000000000013' });
      const oddSplit = ['4', '111', '1111', '1111', '1111'];
      for (const text of oddSplit) store.appendTranscript(odd.id, { speaker: 'caller', text });
      expect(odd.transcript).toEqual(oddSplit.map((t) => `caller: ${t}`));
    });

    // Gate codes, last-four answers and years given one per turn read exactly
    // like a card read group by group; only a mention of the card tells them
    // apart, and the agent's lines around the window are read for it.
    it("stitches a group of four per caller turn only where the card is mentioned, the agent's lines included", async () => {
      const { repo, redactCardNumberTurns } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const groups = ['4111', '1111', '1111', '1111'];
      const codes = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      store.appendTranscript(codes.id, { speaker: 'agent', text: "I'll text you a payment link. What is the gate code?" });
      for (const text of groups) store.appendTranscript(codes.id, { speaker: 'caller', text });
      await codes.cardRedactionWrites;
      expect(codes.transcript.filter((line) => line.includes(MARKER))).toEqual([]);
      expect(redactCardNumberTurns).not.toHaveBeenCalled();

      const card = store.create('tenant-a', 'telephony', { callSid: 'CA00000000000000000000000000000014' });
      store.appendTranscript(card.id, { speaker: 'caller', text: groups[0] });
      store.appendTranscript(card.id, { speaker: 'agent', text: AGENT_ON_CARD });
      for (const text of groups.slice(1)) store.appendTranscript(card.id, { speaker: 'caller', text });
      expect(card.transcript).toEqual([
        `caller: ${MARKER}`,
        `agent: ${AGENT_ON_CARD}`,
        ...Array(3).fill(`caller: ${MARKER}`),
      ]);
      await card.cardRedactionWrites;
      expect(redactCardNumberTurns).toHaveBeenCalledTimes(1);
    });

    // "my card number is", then "okay" (or the agent's "go ahead with the
    // card number" answered with "okay"), then the groups: the pause turn
    // hid the mention, and every shape below has a turn of four digits or
    // fewer, which needs it.
    it.each([
      ['Visa 4-4-4-4', ['4111', '1111', '1111', '1111']],
      ['Amex 4-6-5', ['3782', '822463', '10005']],
      ['Diners Club 4-6-4', ['3614', '890064', '7913']],
      ['Visa 4-12', ['4111', '1111 1111 1111']],
    ] as const)('stitches %s read after a pause turn that follows the mention of the card', async (_name, groups) => {
      const leads: ReadonlyArray<ReadonlyArray<readonly ['caller' | 'agent', string]>> = [
        [['caller', 'my card number is'], ['caller', 'okay']],
        [['caller', 'my card number is'], ['caller', 'um']],
        [['caller', 'my card number is'], ['agent', 'Sure, go ahead.'], ['caller', 'mm-hmm']],
        [['agent', 'Go ahead with the card number.'], ['caller', 'okay']],
        [['agent', 'Go ahead with the card number.'], ['caller', 'okay'], ['agent', 'Go on.']],
      ];
      for (const [k, lead] of leads.entries()) {
        const { repo, redactCardNumberTurns } = splitRepo();
        const store = newStore({ callTranscriptTurnRepo: repo });
        const session = store.create('tenant-a', 'telephony', { callSid: `CA0000000000000000000000000000${String(40 + k).padStart(4, '0')}` });
        let ts = 1_000_000;
        for (const [speaker, text] of lead) store.appendTranscript(session.id, { speaker, text, ts: (ts += 2000) });
        groups.forEach((text, g) => {
          if (g > 0) store.appendTranscript(session.id, { speaker: 'agent', text: 'Go on.', ts: (ts += 2000) });
          store.appendTranscript(session.id, { speaker: 'caller', text, ts: (ts += 2000) });
        });
        const label = lead.map(([, text]) => text).join(' | ');
        expect(session.transcript.filter((line) => line.startsWith('caller:') && /\d/.test(line)), label).toEqual([]);
        expect(session.transcript.filter((line) => line === `caller: ${MARKER}`), label).toHaveLength(groups.length);
        await session.cardRedactionWrites;
        expect(redactCardNumberTurns, label).toHaveBeenCalledTimes(1);
      }
      // With nothing naming the card, the same turns are left alone.
      const { repo, redactCardNumberTurns } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      let ts = 1_000_000;
      for (const text of ['the gate is on the left', 'okay', ...groups]) store.appendTranscript(session.id, { speaker: 'caller', text, ts: (ts += 2000) });
      expect(session.transcript).toEqual(['the gate is on the left', 'okay', ...groups].map((text) => `caller: ${text}`));
      await session.cardRedactionWrites;
      expect(redactCardNumberTurns).not.toHaveBeenCalled();
    });

    // Every caller turn is read with the turns before it, which also finds a
    // "card" wholly inside the new turn: a mention of the card there counts
    // only near the digits, as it does for the turn alone.
    it('leaves a turn alone whose card mention is far from its digits, once earlier caller turns are in the window', async () => {
      const { repo, redactCardNumberTurns } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      // 4118 1215 1230 1545 passes the Luhn check: four times read in pairs.
      const far =
        'I will pay by card when he comes. and the technician said the unit was old and the filter was dirty and the coil needed ' +
        'cleaning and he would come back next week to check the pressure again after the part arrives. the times he gave me were ' +
        'forty-one eighteen, twelve fifteen, twelve thirty, fifteen forty-five';
      store.appendTranscript(session.id, { speaker: 'caller', text: 'hi' });
      store.appendTranscript(session.id, { speaker: 'agent', text: 'Go ahead.' });
      expect(store.appendTranscript(session.id, { speaker: 'caller', text: far })).toEqual({ text: far, rewrittenTurnIndexes: [] });
      expect(session.transcript).toEqual(['caller: hi', 'agent: Go ahead.', `caller: ${far}`]);
      await session.cardRedactionWrites;
      expect(redactCardNumberTurns).not.toHaveBeenCalled();
    });

    it("never touches another session's turns", () => {
      const { repo } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const a = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
      const b = store.create('tenant-a', 'telephony', { callSid: 'CA00000000000000000000000000000012' });
      store.appendTranscript(b.id, { speaker: 'caller', text: '4111 1111' });
      store.appendTranscript(a.id, { speaker: 'caller', text: '4111 1111' });
      store.appendTranscript(a.id, { speaker: 'caller', text: '1111 1111' });
      expect(a.transcript).toEqual([`caller: ${MARKER}`, `caller: ${MARKER}`]);
      expect(b.transcript).toEqual(['caller: 4111 1111']);
    });

    it('rewrites an in-app session in memory (its running transcript is persisted from it) with no turn-row write', async () => {
      const { repo, redactCardNumberTurns } = splitRepo();
      const store = newStore({ callTranscriptTurnRepo: repo });
      const session = store.create('tenant-a', 'inapp');
      store.appendTranscript(session.id, { speaker: 'caller', text: 'cuatro uno uno uno, uno uno uno uno' });
      store.appendTranscript(session.id, { speaker: 'caller', text: 'uno uno uno uno, uno uno uno uno' });
      await session.cardRedactionWrites;
      expect(session.transcript).toEqual([`caller: ${MARKER}`, `caller: ${MARKER}`]);
      expect(redactCardNumberTurns).not.toHaveBeenCalled();
    });

    it('a failing rewrite never throws into the call path and is logged', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const { repo, redactCardNumberTurns } = splitRepo();
        redactCardNumberTurns.mockRejectedValueOnce(new Error('db down'));
        const store = newStore({ callTranscriptTurnRepo: repo });
        const session = store.create('tenant-a', 'telephony', { callSid: CALL_SID });
        store.appendTranscript(session.id, { speaker: 'caller', text: '4111 1111' });
        expect(() => store.appendTranscript(session.id, { speaker: 'caller', text: '1111 1111' })).not.toThrow();
        await session.cardRedactionWrites;
        expect(errorSpy).toHaveBeenCalledWith(
          'voice-session-store: card-number rewrite of stored turns failed',
          expect.objectContaining({ turnIndexes: [0, 1], error: 'db down' }),
        );
        // The memory side stands regardless.
        expect(session.transcript).toEqual([`caller: ${MARKER}`, `caller: ${MARKER}`]);
        // The rewrite that did not land is kept for the recording hook to
        // write before the call is ingested (rows by id, already redacted).
        expect(session.unwrittenCardRedactions).toEqual([
          [
            { id: 'row-0', turnIndex: 0, text: MARKER },
            { id: 'row-1', turnIndex: 1, text: MARKER },
          ],
        ]);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});
