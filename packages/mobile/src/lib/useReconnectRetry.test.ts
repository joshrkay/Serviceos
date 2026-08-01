// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReconnectRetry } from './useReconnectRetry';
import { __emitNetInfoForTests, __resetConnectivityForTests } from './connectivity';

function Probe({ retry, enabled }: { retry: () => unknown; enabled: boolean }) {
  useReconnectRetry(retry, enabled);
  return null;
}

beforeEach(() => __resetConnectivityForTests());
afterEach(() => {
  cleanup();
  __resetConnectivityForTests();
});

describe('useReconnectRetry', () => {
  it('re-runs the failed read on an offline→online edge when enabled', () => {
    const retry = vi.fn();
    render(createElement(Probe, { retry, enabled: true }));
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not retry when disabled (a healthy screen)', () => {
    const retry = vi.fn();
    render(createElement(Probe, { retry, enabled: false }));
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    expect(retry).not.toHaveBeenCalled();
  });

  it('uses the latest retry callback after a re-render (no stale closure)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(createElement(Probe, { retry: first, enabled: true }));
    rerender(createElement(Probe, { retry: second, enabled: true }));
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    const retry = vi.fn();
    const { unmount } = render(createElement(Probe, { retry, enabled: true }));
    unmount();
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    expect(retry).not.toHaveBeenCalled();
  });
});
