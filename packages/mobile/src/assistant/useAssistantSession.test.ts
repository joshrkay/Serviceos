// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ReactNative from 'react-native';
import {
  useAssistantSession,
  AssistantForbiddenError,
  type AssistantTransport,
  type EventStreamResult,
} from './useAssistantSession';
import type { VoiceSessionMessage } from './sseParser';

// The react-native stub (vitest.config.ts alias) exposes a test-only AppState
// driver; the real RN types don't declare it, so reach it through a cast.
const __emitAppState = (ReactNative as unknown as {
  __emitAppState: (state: string) => void;
}).__emitAppState;

/** A controllable SSE stream the test drives (push frames, resolve, or leave open). */
interface FakeStream {
  push: (m: VoiceSessionMessage) => void;
  resolve: (r: EventStreamResult) => void;
  signal: AbortSignal;
  forceRefresh: boolean;
}

function makeTransport(overrides: Partial<AssistantTransport> = {}) {
  const streams: FakeStream[] = [];
  const openEvents = vi.fn(
    (
      _id: string,
      handlers: { onMessage: (m: VoiceSessionMessage) => void },
      signal: AbortSignal,
      opts?: { forceRefresh?: boolean },
    ) =>
      new Promise<EventStreamResult>((resolve) => {
        const stream: FakeStream = {
          push: handlers.onMessage,
          resolve,
          signal,
          forceRefresh: Boolean(opts?.forceRefresh),
        };
        streams.push(stream);
        // A real abort (unmount / end / resubscribe) settles the promise.
        signal.addEventListener('abort', () => resolve({ status: 200 }));
      }),
  );
  const transport: AssistantTransport = {
    start: vi.fn(async () => ({
      sessionId: 'sess-1',
      state: 'intent_capture',
      greetingText: 'Hi, how can I help?',
      greetingAudio: 'GREET_B64',
    })),
    sendInput: vi.fn(async () => ({ status: 200, state: 'intent_capture' }) as const),
    transcribe: vi.fn(async () => ({ transcript: 'invoice acme' })),
    end: vi.fn(async () => {}),
    openEvents,
    ...overrides,
  };
  return { transport, streams, openEvents };
}

const player = { play: vi.fn() };

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('useAssistantSession', () => {
  it('start → greeting → input → async event → ended', async () => {
    const { transport, streams } = makeTransport({
      sendInput: vi.fn(async () => ({
        status: 200,
        state: 'closing',
        ttsText: 'Done — invoice drafted.',
        ttsAudio: 'TTS_B64',
        proposalIds: ['prop-9'],
        ended: true,
      })),
    });
    const { result } = renderHook(() => useAssistantSession({ transport, player }));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('active');
    expect(result.current.state).toBe('intent_capture');
    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'assistant', text: 'Hi, how can I help?' }),
    ]);
    expect(player.play).toHaveBeenCalledWith('GREET_B64');
    // The event stream was opened.
    await waitFor(() => expect(streams.length).toBe(1));

    // An async proposal push arrives over SSE before the turn completes.
    act(() => streams[0].push({ type: 'proposal_created', proposalId: 'prop-async' }));
    expect(result.current.proposalIds).toContain('prop-async');

    await act(async () => {
      await result.current.sendText('invoice acme for 450');
    });
    expect(result.current.turns.map((t) => t.text)).toEqual([
      'Hi, how can I help?',
      'invoice acme for 450',
      'Done — invoice drafted.',
    ]);
    expect(player.play).toHaveBeenCalledWith('TTS_B64');
    expect(result.current.proposalIds).toEqual(expect.arrayContaining(['prop-async', 'prop-9']));
    expect(result.current.status).toBe('ended');
    // Stream aborted on end.
    expect(streams[0].signal.aborted).toBe(true);
  });

  it('updates state and ends from an SSE "ended" frame', async () => {
    const { transport, streams } = makeTransport();
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(streams.length).toBe(1));
    act(() => streams[0].push({ type: 'ended', reason: 'idle_timeout' }));
    expect(result.current.status).toBe('ended');
  });

  it('401 on the event stream retries once with a refreshed token, then succeeds', async () => {
    const { transport, streams, openEvents } = makeTransport();
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(streams.length).toBe(1));

    // First connection is rejected 401 (no forceRefresh yet).
    await act(async () => {
      streams[0].resolve({ status: 401 });
    });
    // Hook reconnects once, forcing a token refresh.
    await waitFor(() => expect(streams.length).toBe(2));
    expect(streams[1].forceRefresh).toBe(true);
    expect(openEvents).toHaveBeenCalledTimes(2);
    // Session stays usable; no auth error surfaced.
    expect(result.current.status).toBe('active');
    expect(result.current.error).toBeNull();
  });

  it('a persistent 401 (both attempts) surfaces auth gracefully without looping', async () => {
    const { transport, streams, openEvents } = makeTransport();
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(streams.length).toBe(1));
    await act(async () => streams[0].resolve({ status: 401 }));
    await waitFor(() => expect(streams.length).toBe(2));
    await act(async () => streams[1].resolve({ status: 401 }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error?.kind).toBe('auth');
    // No third attempt.
    expect(openEvents).toHaveBeenCalledTimes(2);
  });

  it('403 on start (persona without ai:run) surfaces forbidden gracefully', async () => {
    const { transport } = makeTransport({
      start: vi.fn(async () => {
        throw new AssistantForbiddenError();
      }),
    });
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error?.kind).toBe('forbidden');
  });

  it('aborts the stream on unmount', async () => {
    const { transport, streams } = makeTransport();
    const { result, unmount } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(streams.length).toBe(1));
    expect(streams[0].signal.aborted).toBe(false);
    unmount();
    expect(streams[0].signal.aborted).toBe(true);
  });

  it('stream drop degrades to sync input round-trips (no reconnect loop)', async () => {
    const { transport, streams, openEvents } = makeTransport({
      sendInput: vi.fn(async () => ({ status: 200, state: 'intent_confirm', ttsText: 'Got it.' })),
    });
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(streams.length).toBe(1));

    // The connected stream breaks mid-flight.
    await act(async () => streams[0].resolve({ status: 200, dropped: true }));
    // No reconnect was attempted.
    expect(openEvents).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('active');

    // Sync input still works — the degrade path.
    await act(async () => {
      await result.current.sendText('what is my balance');
    });
    expect(result.current.turns.map((t) => t.text)).toContain('Got it.');
    expect(result.current.status).toBe('active');
  });

  it('410 from a sync input on an ended session → expired, no retry', async () => {
    const send = vi.fn(async () => ({ status: 410 }) as const);
    const { transport } = makeTransport({ sendInput: send });
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.sendText('approve the Rodriguez estimate');
    });
    expect(result.current.status).toBe('expired');
    expect(send).toHaveBeenCalledTimes(1);
    // A further send is ignored (not 'active') — no retry into the gone session.
    await act(async () => {
      await result.current.sendText('again');
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('404 from a sync input (reaped session) → expired', async () => {
    const { transport } = makeTransport({ sendInput: vi.fn(async () => ({ status: 404 }) as const) });
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.sendText('hi');
    });
    expect(result.current.status).toBe('expired');
  });

  it('AppState foreground after a >30min reap reconnects and takes the 404 → expired path', async () => {
    // The reconnect after resume returns 404 (session removed by the reaper).
    let call = 0;
    const openEvents = vi.fn((_id, _h, signal: AbortSignal) => {
      call += 1;
      if (call === 1) {
        return new Promise<EventStreamResult>((resolve) => {
          signal.addEventListener('abort', () => resolve({ status: 200 }));
        });
      }
      return Promise.resolve<EventStreamResult>({ status: 404 });
    });
    const { transport } = makeTransport({ openEvents: openEvents as never });
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(openEvents).toHaveBeenCalledTimes(1));

    // Background then foreground after the TTL elapsed.
    await act(async () => {
      __emitAppState('background');
      __emitAppState('active');
    });
    await waitFor(() => expect(result.current.status).toBe('expired'));
    expect(openEvents).toHaveBeenCalledTimes(2);
    // No retry loop after expiry.
    await act(async () => {
      __emitAppState('background');
      __emitAppState('active');
    });
    expect(openEvents).toHaveBeenCalledTimes(2);
  });

  it('per-turn STT 501 sets sttUnavailable (text-input fallback), no turn sent', async () => {
    const send = vi.fn(async () => ({ status: 200 }) as const);
    const { transport } = makeTransport({
      transcribe: vi.fn(async () => ({ notConfigured: true }) as const),
      sendInput: send,
    });
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.sendAudio('file:///c.m4a');
    });
    expect(result.current.sttUnavailable).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('per-turn STT success feeds the transcript through as a turn', async () => {
    const { transport } = makeTransport({
      transcribe: vi.fn(async () => ({ transcript: 'invoice the Hendersons' })),
      sendInput: vi.fn(async () => ({ status: 200, state: 'intent_confirm', ttsText: 'On it.' })),
    });
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.sendAudio('file:///c.m4a');
    });
    expect(result.current.turns.map((t) => t.text)).toContain('invoice the Hendersons');
    expect(result.current.turns.map((t) => t.text)).toContain('On it.');
  });

  it('end() tears down and resets to idle', async () => {
    const { transport, streams } = makeTransport();
    const { result } = renderHook(() => useAssistantSession({ transport, player }));
    await act(async () => {
      await result.current.start();
    });
    await waitFor(() => expect(streams.length).toBe(1));
    await act(async () => {
      await result.current.end();
    });
    expect(transport.end).toHaveBeenCalledWith('sess-1');
    expect(result.current.status).toBe('idle');
    expect(result.current.sessionId).toBeNull();
    expect(result.current.turns).toEqual([]);
  });
});
