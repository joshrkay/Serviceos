/**
 * #1019 6.1b (G1 2, ZERO tests) — useVoiceSession hook tests.
 *
 * useVoiceSession is imported ONLY by VoiceSessionPanel and had no test
 * coverage at all before this file. Covers the round trip the hook exists
 * to drive: start() posts /api/voice/sessions and applies the greeting,
 * send() is guarded with no active session and otherwise posts input and
 * applies the response, end() resets full session-scoped state, and the
 * SSE line handler dedupes a redelivered proposal_created event (the one
 * piece of real logic buried in `handleSseLine`).
 *
 * The Clerk mock comes from `test-setup.ts`; `useApiClient` resolves to a
 * Bearer-injecting fetch wrapper, but this file stubs `globalThis.fetch`
 * directly so responses are fully controlled, matching the sibling
 * `useDispatchBoardStream.test.tsx` pattern for the SSE leg.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceSession } from './useVoiceSession';

/** Builds a ReadableStream-shaped body (matching the hook's getReader() use) from raw SSE blocks. */
function sseBody(blocks: string[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async (): Promise<{ value?: Uint8Array; done: boolean }> => {
        if (i < blocks.length) {
          return { value: new TextEncoder().encode(blocks[i++]), done: false };
        }
        // Keep the stream open — the hook's read loop parks here, exactly
        // like the real SSE connection would between events.
        return new Promise(() => {});
      },
    }),
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

const fetchMock = vi.fn();

describe('useVoiceSession', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function routeFetch(opts: {
    events?: Array<Record<string, unknown>>;
    sendBody?: Record<string, unknown>;
  } = {}) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/voice/sessions' && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessionId: 'sess-1',
            state: 'greeting',
            greetingText: 'Hi, how can I help?',
          }),
        } as Response;
      }
      if (/\/api\/voice\/sessions\/[^/]+\/events$/.test(url) && method === 'GET') {
        const blocks = (opts.events ?? []).map((e) => `data: ${JSON.stringify(e)}\n\n`);
        return { ok: true, status: 200, body: sseBody(blocks) } as unknown as Response;
      }
      if (/\/api\/voice\/sessions\/[^/]+\/input$/.test(url) && method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: 'intent_capture',
            ttsText: 'Got it.',
            proposalIds: [],
            ...opts.sendBody,
          }),
        } as Response;
      }
      if (/\/api\/voice\/sessions\/[^/]+$/.test(url) && method === 'DELETE') {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  it('start() posts /api/voice/sessions and applies the session id, state, and greeting', async () => {
    routeFetch();
    const { result, unmount } = renderHook(() => useVoiceSession());

    await act(async () => {
      await result.current.start();
    });
    await flush();

    expect(result.current.sessionId).toBe('sess-1');
    expect(result.current.state).toBe('greeting');
    expect(result.current.lastTtsText).toBe('Hi, how can I help?');
    expect(result.current.ended).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice/sessions',
      expect.objectContaining({ method: 'POST' }),
    );
    unmount();
  });

  it('send() is a no-op with no active session — never posts input', async () => {
    routeFetch();
    const { result, unmount } = renderHook(() => useVoiceSession());

    await act(async () => {
      await result.current.send('hello');
    });
    await flush();

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/input')),
    ).toBe(false);
    unmount();
  });

  it('send() posts input and applies the returned state, TTS text, and proposal ids', async () => {
    routeFetch({ sendBody: { proposalIds: ['prop-1'] } });
    const { result, unmount } = renderHook(() => useVoiceSession());

    await act(async () => {
      await result.current.start();
    });
    await flush();

    await act(async () => {
      await result.current.send('book me for Thursday');
    });
    await flush();

    expect(result.current.state).toBe('intent_capture');
    expect(result.current.lastTtsText).toBe('Got it.');
    expect(result.current.proposalIds).toEqual(['prop-1']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice/sessions/sess-1/input',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'book me for Thursday' }) }),
    );
    unmount();
  });

  it('end() resets sessionId, state, and proposal ids — a fresh start() is possible again', async () => {
    routeFetch({ sendBody: { proposalIds: ['prop-1'] } });
    const { result, unmount } = renderHook(() => useVoiceSession());

    await act(async () => {
      await result.current.start();
    });
    await flush();
    await act(async () => {
      await result.current.send('hi');
    });
    await flush();

    await act(async () => {
      await result.current.end();
    });
    await flush();

    expect(result.current.sessionId).toBeNull();
    expect(result.current.state).toBeNull();
    expect(result.current.ended).toBe(true);
    expect(result.current.proposalIds).toEqual([]);
    expect(result.current.lastTtsText).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice/sessions/sess-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    unmount();
  });

  it('a redelivered proposal_created SSE event is deduped, not appended twice', async () => {
    routeFetch({
      events: [
        { type: 'proposal_created', proposalId: 'prop-dup' },
        { type: 'proposal_created', proposalId: 'prop-dup' },
        { type: 'proposal_created', proposalId: 'prop-2' },
      ],
    });
    const { result, unmount } = renderHook(() => useVoiceSession());

    await act(async () => {
      await result.current.start();
    });
    await flush();

    await waitFor(() => {
      expect(result.current.proposalIds).toEqual(['prop-dup', 'prop-2']);
    });
    unmount();
  });

  it('an SSE "ended" event marks the session ended', async () => {
    routeFetch({ events: [{ type: 'ended' }] });
    const { result, unmount } = renderHook(() => useVoiceSession());

    await act(async () => {
      await result.current.start();
    });
    await flush();

    await waitFor(() => {
      expect(result.current.ended).toBe(true);
    });
    unmount();
  });
});
