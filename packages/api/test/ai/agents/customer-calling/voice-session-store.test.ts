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
      return { repo: { recordTurn }, recordTurn };
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
});
