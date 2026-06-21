import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __emitNetInfoForTests,
  __resetConnectivityForTests,
  isCurrentlyOnline,
  onReconnect,
  subscribeConnectivity,
} from './connectivity';

beforeEach(() => __resetConnectivityForTests());
afterEach(() => __resetConnectivityForTests());

describe('subscribeConnectivity', () => {
  it('fires immediately with the current (online) state', () => {
    const seen: boolean[] = [];
    subscribeConnectivity((online) => seen.push(online));
    expect(seen).toEqual([true]);
  });

  it('pushes offline then online as NetInfo reports them', () => {
    const seen: boolean[] = [];
    subscribeConnectivity((online) => seen.push(online));
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    expect(seen).toEqual([true, false, true]);
    expect(isCurrentlyOnline()).toBe(true);
  });

  it('treats a connected-but-no-internet state (captive portal) as offline', () => {
    const seen: boolean[] = [];
    subscribeConnectivity((online) => seen.push(online));
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: false });
    expect(seen).toEqual([true, false]);
  });

  it('treats an undetermined (null) state as online so it never flashes the banner', () => {
    const seen: boolean[] = [];
    subscribeConnectivity((online) => seen.push(online));
    __emitNetInfoForTests({ isConnected: null, isInternetReachable: null });
    expect(seen).toEqual([true, true]);
  });

  it('stops delivering after unsubscribe', () => {
    const seen: boolean[] = [];
    const unsub = subscribeConnectivity((online) => seen.push(online));
    unsub();
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    expect(seen).toEqual([true]);
  });
});

describe('onReconnect', () => {
  it('fires only on an offline→online edge, not the initial state', () => {
    const reconnect = vi.fn();
    onReconnect(reconnect);
    // Initial online emit: no edge.
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    expect(reconnect).not.toHaveBeenCalled();
    // Go offline, then back online: one edge.
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('does not fire while staying offline', () => {
    const reconnect = vi.fn();
    onReconnect(reconnect);
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: null });
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('stops firing after unsubscribe', () => {
    const reconnect = vi.fn();
    const unsub = onReconnect(reconnect);
    __emitNetInfoForTests({ isConnected: false, isInternetReachable: false });
    unsub();
    __emitNetInfoForTests({ isConnected: true, isInternetReachable: true });
    expect(reconnect).not.toHaveBeenCalled();
  });
});
