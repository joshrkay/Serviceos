/**
 * ITEM 4 — transcript-append dedup helper.
 *
 * Pins that the extracted `appendAgentTts` helper correctly finds the last
 * tts_play effect and appends it, and that it is a no-op when none present.
 */
import { describe, it, expect } from 'vitest';
import { callerTranscriptText,
  REDACTED_CHALLENGE_TEXT, appendAgentTts } from '../../../src/ai/voice-turn/transcript-append';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

function makeStore() {
  const calls: { sessionId: string; speaker: string; text: string }[] = [];
  return {
    appendTranscript(sessionId: string, entry: { speaker: 'caller' | 'agent'; text: string; ts: number }) {
      calls.push({ sessionId, speaker: entry.speaker, text: entry.text });
    },
    calls,
  };
}

describe('appendAgentTts', () => {
  it('appends the last tts_play text as an agent entry', () => {
    const store = makeStore();
    const effects: SideEffect[] = [
      { type: 'tts_play', payload: { text: 'First line' } },
      { type: 'audit_log', payload: { eventType: 'test' } },
      { type: 'tts_play', payload: { text: 'Last line' } },
    ];
    appendAgentTts(store, 'sess-1', effects);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({ sessionId: 'sess-1', speaker: 'agent', text: 'Last line' });
  });

  it('is a no-op when no tts_play is present', () => {
    const store = makeStore();
    const effects: SideEffect[] = [
      { type: 'audit_log', payload: { eventType: 'test' } },
    ];
    appendAgentTts(store, 'sess-1', effects);
    expect(store.calls).toHaveLength(0);
  });

  it('is a no-op when effects array is empty', () => {
    const store = makeStore();
    appendAgentTts(store, 'sess-1', []);
    expect(store.calls).toHaveLength(0);
  });

  it('skips tts_play when text is not a string', () => {
    const store = makeStore();
    const effects: SideEffect[] = [
      { type: 'tts_play', payload: { template: 'confirm_intent' } as unknown as { text: string } },
    ];
    appendAgentTts(store, 'sess-1', effects);
    expect(store.calls).toHaveLength(0);
  });

  it('uses the session id passed in, not a hardcoded value', () => {
    const store = makeStore();
    appendAgentTts(store, 'unique-session-42', [
      { type: 'tts_play', payload: { text: 'hello' } },
    ]);
    expect(store.calls[0].sessionId).toBe('unique-session-42');
  });
});

/**
 * #850 follow-up — `callerTranscriptText` had no direct tests.
 *
 * The original fix was verified only through the Gather adapter, which is why
 * a SECOND caller-append site (`speechTurn`, reached on the media-streams
 * path) went unguarded and re-leaked the secret the first site had redacted.
 * Testing the helper directly makes the contract explicit for every call site,
 * present and future.
 */
describe('callerTranscriptText', () => {
  it('redacts while the session awaits a spoken approval challenge', () => {
    const session = { pendingVoiceApproval: { stage: 'challenge' } };
    expect(callerTranscriptText(session, '4821')).toBe(REDACTED_CHALLENGE_TEXT);
  });

  it.each(['confirm', 'disambiguate', undefined])(
    'passes the utterance through at stage %s',
    (stage) => {
      const session = { pendingVoiceApproval: stage ? { stage } : undefined };
      expect(callerTranscriptText(session, 'my boiler is leaking')).toBe('my boiler is leaking');
    },
  );

  it('passes through when there is no approval dialogue at all', () => {
    expect(callerTranscriptText({}, 'book me for Tuesday')).toBe('book me for Tuesday');
    expect(callerTranscriptText(undefined, 'book me for Tuesday')).toBe('book me for Tuesday');
  });

  it('redacts on stage alone, never on the shape of the utterance', () => {
    // The guard must not try to recognise "looks like a PIN": that would leak
    // ("the code is 4821") and over-redact ("4821 Bridgewater Road").
    const challenging = { pendingVoiceApproval: { stage: 'challenge' } };
    expect(callerTranscriptText(challenging, 'the code is four eight two one')).toBe(
      REDACTED_CHALLENGE_TEXT,
    );
    expect(callerTranscriptText({}, '4821 Bridgewater Road')).toBe('4821 Bridgewater Road');
  });
});
