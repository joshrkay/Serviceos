import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestOfflineFlush,
  subscribeOfflineFlushRequests,
  __resetOfflineFlushSignalForTests,
} from './flushSignal';

afterEach(() => __resetOfflineFlushSignalForTests());

describe('offline flush signal', () => {
  it('notifies every subscriber on a request', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeOfflineFlushRequests(a);
    subscribeOfflineFlushRequests(b);

    requestOfflineFlush();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    requestOfflineFlush();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('stops notifying after unsubscribe', () => {
    const fn = vi.fn();
    const stop = subscribeOfflineFlushRequests(fn);
    requestOfflineFlush();
    stop();
    requestOfflineFlush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with no subscribers', () => {
    expect(() => requestOfflineFlush()).not.toThrow();
  });
});
