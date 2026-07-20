import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestOfflineFlush,
  subscribeOfflineFlushRequests,
  __resetOfflineFlushSignalForTests,
} from './flushSignal';

afterEach(() => __resetOfflineFlushSignalForTests());

describe('offline flush signal', () => {
  it('notifies every subscriber on a request', async () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeOfflineFlushRequests(a);
    subscribeOfflineFlushRequests(b);

    await requestOfflineFlush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    await requestOfflineFlush();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('awaits async listeners before resolving', async () => {
    const order: string[] = [];
    subscribeOfflineFlushRequests(async () => {
      await Promise.resolve();
      order.push('listener-done');
    });
    await requestOfflineFlush();
    order.push('request-resolved');
    expect(order).toEqual(['listener-done', 'request-resolved']);
  });

  it('resolves even when a listener rejects (allSettled)', async () => {
    const ok = vi.fn();
    subscribeOfflineFlushRequests(() => Promise.reject(new Error('flush blew up')));
    subscribeOfflineFlushRequests(async () => {
      ok();
    });
    await expect(requestOfflineFlush()).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('does not let a synchronously-throwing listener block the others', async () => {
    const ok = vi.fn();
    subscribeOfflineFlushRequests(() => {
      throw new Error('sync boom');
    });
    subscribeOfflineFlushRequests(ok);
    await expect(requestOfflineFlush()).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('stops notifying after unsubscribe', async () => {
    const fn = vi.fn();
    const stop = subscribeOfflineFlushRequests(fn);
    await requestOfflineFlush();
    stop();
    await requestOfflineFlush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with no subscribers', async () => {
    await expect(requestOfflineFlush()).resolves.toBeUndefined();
  });
});
