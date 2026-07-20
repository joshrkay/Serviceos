// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfflineBanner, offlineBannerCopy } from './OfflineBanner';
import { __emitNetInfoForTests, __resetConnectivityForTests } from '../lib/connectivity';
import { OfflineQueue } from '../offline/queue';
import { __setOfflineQueueForTests } from '../offline/queueInstance';

function memQueue(): OfflineQueue {
  let content: string | null = null;
  return new OfflineQueue({
    read: async () => content,
    write: async (c: string) => {
      content = c;
    },
  });
}

function setOffline(off: boolean): void {
  act(() => {
    __emitNetInfoForTests(
      off
        ? { isConnected: false, isInternetReachable: false }
        : { isConnected: true, isInternetReachable: true },
    );
  });
}

beforeEach(() => {
  __resetConnectivityForTests();
  __setOfflineQueueForTests(memQueue());
});
afterEach(() => {
  cleanup();
  __resetConnectivityForTests();
  __setOfflineQueueForTests(null);
});

describe('OfflineBanner', () => {
  it('renders nothing while online', () => {
    const { container } = render(createElement(OfflineBanner));
    expect(container.textContent).toBe('');
  });

  it('shows the banner when connectivity drops, hides it on reconnect', () => {
    const { container, queryByText } = render(createElement(OfflineBanner));
    setOffline(true);
    expect(queryByText(/offline/i)).toBeTruthy();
    setOffline(false);
    expect(container.textContent).toBe('');
  });

  it('shows the offline queue depth while offline (U12)', async () => {
    const queue = memQueue();
    __setOfflineQueueForTests(queue);
    const { queryByText } = render(createElement(OfflineBanner));
    setOffline(true);
    await act(async () => {
      await queue.enqueueVoice({
        id: 'v1',
        idempotencyKey: 'k1',
        enqueuedAt: '2026-07-20T00:00:00.000Z',
        payload: { localUri: 'file:///doc/offline-voice/v1.m4a', contentType: 'audio/mp4', sizeBytes: 1 },
      });
    });
    expect(queryByText(/1 action saved to send when you reconnect/)).toBeTruthy();
  });

  it('pluralizes the queue-depth copy', () => {
    expect(offlineBannerCopy(0)).toMatch(/we'll refresh when you reconnect/);
    expect(offlineBannerCopy(1)).toContain('1 action saved');
    expect(offlineBannerCopy(3)).toContain('3 actions saved');
  });

  it('spans full width (w-full) so it cannot overflow at 320px', () => {
    const { container } = render(createElement(OfflineBanner));
    setOffline(true);
    const banner = container.querySelector('div');
    expect(banner).toBeTruthy();
    // No fixed pixel width; full-width by class — safe at the 320px floor.
    expect(banner!.className).toMatch(/\bw-full\b/);
    expect(banner!.className).not.toMatch(/w-\[\d+px\]/);
  });
});
