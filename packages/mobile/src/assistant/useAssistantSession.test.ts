// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __emitAppState } from '../../test/stubs/react-native';
import {
  SESSION_ENDED_COPY,
  STT_UNAVAILABLE_COPY,
  useAssistantSession,
  type AssistantSessionDeps,
} from './useAssistantSession';

function okJson(body: unknown, status = 200) {
  return { ok: true, status, json: async () => body } as unknown as Response;
}
function errRes(status: number, body: unknown = {}) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

/** A streaming SSE response whose reader yields the given chunks, then holds. */
function sseResponse(chunks: string[], status = 200): Response {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { value: encoder.encode(chunks[i++]), done: false }
            : { value: undefined, done: true },
      }),
    },
  } as unknown as Response;
}

const START_BODY = {
  sessionId: 'sess-1',
  state: 'intent_capture',
  greetingText: 'Hi Mike — what do you need?',
  greetingAudio: 'YmFzZTY0',
};

function makeDeps(over: Partial<AssistantSessionDeps> = {}) {
  const api = vi.fn();
  const streamFetch = vi.fn(async () => sseResponse([]));
  const getToken = vi.fn(async () => 'jwt');
  const playTts = vi.fn(async () => {});
  return {
    deps: {
      api,
      streamFetch,
      getToken,
      baseUrl: 'https://api.test',
      playTts,
      ...over,
    } as AssistantSessionDeps,
    api,
    streamFetch,
    getToken,
    playTts,
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('useAssistantSession', () => {
  it('start → greeting turn + TTS + SSE subscription with header auth', async () => {
    const { deps, api, streamFetch, playTts } = makeDeps();
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    const { result } = renderHook(() => useAssistantSession(deps));

    await act(async () => {
      await result.current.start();
    });
    await settle();

    expect(result.current.phase).toBe('active');
    expect(result.current.fsmState).toBe('intent_capture');
    expect(result.current.turns).toEqual([
      { id: 1, role: 'agent', text: 'Hi Mike — what do you need?' },
    ]);
    expect(playTts).toHaveBeenCalledWith('YmFzZTY0');
    // Header-auth streaming — the token rides Authorization, never the URL.
    const [url, init] = streamFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/api/voice/sessions/sess-1/events');
    expect(url).not.toContain('token=');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
  });

  it('input round trip: owner turn, agent reply, proposal chips from events', async () => {
    const { deps, api } = makeDeps({
      streamFetch: async () =>
        sseResponse([
          'data: {"type":"snapshot","state":"intent_capture"}\n\n',
          'data: {"type":"proposal_created","proposalId":"p9"}\n\n',
        ]),
    });
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    const { result } = renderHook(() => useAssistantSession(deps));
    await act(async () => {
      await result.current.start();
    });
    await settle();

    api.mockResolvedValueOnce(
      okJson({ state: 'closing', ttsText: 'Done — drafted it.', proposalIds: ['p1'] }),
    );
    await act(async () => {
      await result.current.sendText("what's my balance?");
    });

    expect(result.current.turns.map((t) => [t.role, t.text])).toEqual([
      ['agent', 'Hi Mike — what do you need?'],
      ['owner', "what's my balance?"],
      ['agent', 'Done — drafted it.'],
    ]);
    expect(result.current.proposalIds).toEqual(expect.arrayContaining(['p1', 'p9']));
    expect(result.current.fsmState).toBe('closing');
  });

  it('retries the SSE subscribe once with a refreshed token on 401', async () => {
    const { deps, streamFetch, getToken, api } = makeDeps();
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    streamFetch
      .mockResolvedValueOnce(sseResponse([], 401))
      .mockResolvedValueOnce(sseResponse(['data: {"state":"intent_capture"}\n\n']));
    const { result } = renderHook(() => useAssistantSession(deps));

    await act(async () => {
      await result.current.start();
    });
    await settle();

    expect(streamFetch).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledWith({ forceRefresh: true });
    expect(result.current.phase).toBe('active');
  });

  it('surfaces a 403 persona rejection as unavailable, not an error', async () => {
    const { deps, api } = makeDeps();
    api.mockResolvedValueOnce(errRes(403, { error: 'FORBIDDEN' }));
    const { result } = renderHook(() => useAssistantSession(deps));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.phase).toBe('unavailable');
    expect(result.current.error).toBeNull();
  });

  it('degrades to the sync round trip when the stream breaks', async () => {
    const { deps, api } = makeDeps({
      streamFetch: async () => {
        throw new Error('stream failed');
      },
    });
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    const { result } = renderHook(() => useAssistantSession(deps));
    await act(async () => {
      await result.current.start();
    });
    await settle();

    expect(result.current.phase).toBe('active'); // stream loss ≠ session loss

    api.mockResolvedValueOnce(okJson({ state: 'closing', ttsText: 'Still here.' }));
    await act(async () => {
      await result.current.sendText('hello?');
    });
    expect(result.current.turns.at(-1)).toMatchObject({ role: 'agent', text: 'Still here.' });
  });

  it('takes the session-ended path on a 410 from sync input — no retry loop', async () => {
    const { deps, api } = makeDeps();
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    const { result } = renderHook(() => useAssistantSession(deps));
    await act(async () => {
      await result.current.start();
    });
    await settle();

    api.mockResolvedValueOnce(errRes(410, { error: 'GONE', message: 'Session ended' }));
    await act(async () => {
      await result.current.sendText('anyone there?');
    });

    expect(result.current.phase).toBe('ended');
    // A further send is a no-op — nothing retries into the 410.
    const callsBefore = api.mock.calls.length;
    await act(async () => {
      await result.current.sendText('hello?');
    });
    expect(api.mock.calls.length).toBe(callsBefore);
    expect(SESSION_ENDED_COPY).toMatch(/start a new one/i);
  });

  it('handles a reaped session on foreground resume (SSE 410) as ended', async () => {
    const { deps, api, streamFetch } = makeDeps();
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    streamFetch.mockResolvedValueOnce(sseResponse([]));
    const { result } = renderHook(() => useAssistantSession(deps));
    await act(async () => {
      await result.current.start();
    });
    await settle();
    expect(result.current.phase).toBe('active');

    // >30 min in the background → the server idle-reaped the session.
    streamFetch.mockResolvedValueOnce(sseResponse([], 410));
    await act(async () => {
      __emitAppState('active');
    });
    await settle();

    expect(result.current.phase).toBe('ended');
  });

  it('ends the session when the ended event arrives on the stream', async () => {
    const { deps, api } = makeDeps({
      streamFetch: async () => sseResponse(['data: {"type":"ended"}\n\n']),
    });
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    const { result } = renderHook(() => useAssistantSession(deps));
    await act(async () => {
      await result.current.start();
    });
    await settle();

    expect(result.current.phase).toBe('ended');
  });

  it('sendClip: transcribes then sends the transcript as the turn', async () => {
    const { deps, api } = makeDeps();
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    const { result } = renderHook(() => useAssistantSession(deps));
    await act(async () => {
      await result.current.start();
    });
    await settle();

    api
      .mockResolvedValueOnce(okJson({ transcript: 'approve the Rodriguez estimate' }))
      .mockResolvedValueOnce(okJson({ state: 'closing', ttsText: 'Queued for your confirm.' }));
    await act(async () => {
      await result.current.sendClip({ fileUri: 'file:///turn.m4a', contentType: 'audio/mp4' });
    });

    expect(api.mock.calls[1][0]).toBe('/api/voice/transcribe');
    expect(result.current.turns.map((t) => t.text)).toContain('approve the Rodriguez estimate');
    expect(result.current.turns.at(-1)?.text).toBe('Queued for your confirm.');
  });

  it('falls back to text input when transcription answers 501', async () => {
    const { deps, api } = makeDeps();
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    const { result } = renderHook(() => useAssistantSession(deps));
    await act(async () => {
      await result.current.start();
    });
    await settle();

    api.mockResolvedValueOnce(errRes(501, { error: 'NOT_CONFIGURED' }));
    await act(async () => {
      await result.current.sendClip({ fileUri: 'file:///turn.m4a', contentType: 'audio/mp4' });
    });

    expect(result.current.sttUnavailable).toBe(true);
    expect(result.current.error).toBe(STT_UNAVAILABLE_COPY);
    expect(result.current.phase).toBe('active');
  });

  it('end() DELETEs the session and allows a fresh start', async () => {
    const { deps, api } = makeDeps();
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    const { result } = renderHook(() => useAssistantSession(deps));
    await act(async () => {
      await result.current.start();
    });
    await settle();

    api.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) } as unknown as Response);
    await act(async () => {
      await result.current.end();
    });
    expect(result.current.phase).toBe('ended');
    expect(api).toHaveBeenLastCalledWith('/api/voice/sessions/sess-1', { method: 'DELETE' });

    api.mockResolvedValueOnce(okJson({ ...START_BODY, sessionId: 'sess-2' }, 201));
    await act(async () => {
      await result.current.start();
    });
    await settle();
    expect(result.current.phase).toBe('active');
    expect(result.current.turns).toHaveLength(1); // fresh conversation
  });

  it('keeps the session active on a per-turn failure and surfaces the message', async () => {
    const { deps, api } = makeDeps();
    api.mockResolvedValueOnce(okJson(START_BODY, 201));
    const { result } = renderHook(() => useAssistantSession(deps));
    await act(async () => {
      await result.current.start();
    });
    await settle();

    api.mockResolvedValueOnce(errRes(500, { error: 'INTERNAL_ERROR' }));
    await act(async () => {
      await result.current.sendText('try this');
    });

    expect(result.current.phase).toBe('active');
    expect(result.current.error).toBeTruthy();
  });
});
