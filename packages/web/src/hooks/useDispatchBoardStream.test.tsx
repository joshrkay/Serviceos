/**
 * UC-3 — useDispatchBoardStream presence-refetch suppression.
 *
 * When presence rides the WS gateway (presenceViaWs), a presence_updated SSE
 * event must NOT trigger a full board refetch (the presence state already
 * arrived as a dispatch.presence push); board_updated must always refetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDispatchBoardStream } from './useDispatchBoardStream';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue('token') }),
}));

function sseBody(blocks: string[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async (): Promise<{ value?: Uint8Array; done: boolean }> => {
        if (i < blocks.length) {
          return { value: new TextEncoder().encode(blocks[i++]), done: false };
        }
        // Keep the stream open — the hook loop parks on this read.
        return new Promise(() => {});
      },
    }),
  };
}

const fetchMock = vi.fn();

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

describe('useDispatchBoardStream — presenceViaWs', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockStream(events: Array<Record<string, unknown>>) {
    const blocks = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      body: sseBody(blocks),
    });
  }

  it('refetches on presence_updated by default (SSE-only clients unchanged)', async () => {
    const onStale = vi.fn();
    mockStream([{ type: 'presence_updated', date: '2026-05-20' }]);
    const { unmount } = renderHook(() =>
      useDispatchBoardStream('2026-05-20', 'rev-1', onStale),
    );
    await flush();
    expect(onStale).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('skips presence_updated refetch when presence rides the WS, but board_updated still refetches', async () => {
    const onStale = vi.fn();
    mockStream([
      { type: 'presence_updated', date: '2026-05-20' },
      { type: 'board_updated', date: '2026-05-20', boardRevision: 'rev-2' },
    ]);
    const { unmount } = renderHook(() =>
      useDispatchBoardStream('2026-05-20', 'rev-1', onStale, { presenceViaWs: true }),
    );
    await flush();
    expect(onStale).toHaveBeenCalledTimes(1); // the board_updated only
    unmount();
  });
});
