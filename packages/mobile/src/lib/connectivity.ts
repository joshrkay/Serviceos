/**
 * Connectivity source of truth for the error-UX layer.
 *
 * Wraps `@react-native-community/netinfo` (the Expo-SDK-recommended NetInfo) into
 * two small primitives the UI consumes:
 *
 *  - `subscribeConnectivity(listener)` — pushes the current `online` boolean and
 *    every change. `OfflineBanner` uses this to show/hide the persistent banner.
 *  - `onReconnect(listener)` — fires once on each offline→online edge. The read
 *    hooks subscribe (via `useReconnectRetry`) to re-run a query that failed while
 *    offline, so reconnecting heals stale screens without a manual pull.
 *
 * NetInfo is the only native dependency here, so it's the single module the
 * vitest config aliases to a stub (`test/stubs/react-native-community-netinfo.ts`).
 * Everything else in this file is plain JS and unit-tested directly.
 */
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

/** NetInfo reports `isConnected: null` while it's still determining state. */
function isOnline(state: NetInfoState): boolean {
  // Treat "internet reachable === false" as offline even when connected to a
  // network (captive portal / no upstream). `null` (unknown) is treated as
  // online so we never flash an offline banner before NetInfo has decided.
  if (state.isConnected === false) return false;
  if (state.isInternetReachable === false) return false;
  return true;
}

type ConnectivityListener = (online: boolean) => void;
type ReconnectListener = () => void;

const connectivityListeners = new Set<ConnectivityListener>();
const reconnectListeners = new Set<ReconnectListener>();

/** Last known online state; seeded `true` so we don't claim offline pre-NetInfo. */
let online = true;
/** The single underlying NetInfo subscription, opened lazily on first listener. */
let unsubscribeNetInfo: (() => void) | null = null;

function handleNetInfoState(state: NetInfoState): void {
  const next = isOnline(state);
  const wasOffline = !online;
  online = next;
  for (const l of connectivityListeners) l(next);
  // Offline → online edge: heal the screens that failed while disconnected.
  if (next && wasOffline) {
    for (const l of reconnectListeners) l();
  }
}

/** Open the shared NetInfo subscription if it isn't already open. */
function ensureNetInfoSubscribed(): void {
  if (unsubscribeNetInfo) return;
  unsubscribeNetInfo = NetInfo.addEventListener(handleNetInfoState);
}

/** Close the shared subscription once nothing is listening, so it can re-open. */
function maybeUnsubscribeNetInfo(): void {
  if (connectivityListeners.size === 0 && reconnectListeners.size === 0 && unsubscribeNetInfo) {
    unsubscribeNetInfo();
    unsubscribeNetInfo = null;
  }
}

/**
 * Subscribe to connectivity. The listener fires immediately with the current
 * known state, then on every change. Returns an unsubscribe.
 */
export function subscribeConnectivity(listener: ConnectivityListener): () => void {
  connectivityListeners.add(listener);
  ensureNetInfoSubscribed();
  listener(online);
  return () => {
    connectivityListeners.delete(listener);
    maybeUnsubscribeNetInfo();
  };
}

/**
 * Subscribe to offline→online reconnect edges (not the initial state). Returns
 * an unsubscribe.
 */
export function onReconnect(listener: ReconnectListener): () => void {
  reconnectListeners.add(listener);
  ensureNetInfoSubscribed();
  return () => {
    reconnectListeners.delete(listener);
    maybeUnsubscribeNetInfo();
  };
}

/** Current known online state (last value NetInfo reported). */
export function isCurrentlyOnline(): boolean {
  return online;
}

/**
 * Test-only: reset module state between cases and drive a NetInfo update through
 * the same path the real subscription uses.
 */
export function __resetConnectivityForTests(): void {
  connectivityListeners.clear();
  reconnectListeners.clear();
  if (unsubscribeNetInfo) unsubscribeNetInfo();
  unsubscribeNetInfo = null;
  online = true;
}

/** Test-only: feed a NetInfo state as if the native module emitted it. */
export function __emitNetInfoForTests(state: Partial<NetInfoState>): void {
  handleNetInfoState(state as NetInfoState);
}
