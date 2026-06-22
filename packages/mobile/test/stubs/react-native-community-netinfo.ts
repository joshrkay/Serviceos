// Resolve-time stub for @react-native-community/netinfo under the jsdom/node
// test env. The real package has a native module entry that doesn't resolve in
// the root-only CI lane (packages/mobile is not a workspace), and the
// connectivity layer only needs `addEventListener` returning an unsubscribe.
// Tests drive state through `connectivity.ts`'s `__emitNetInfoForTests` (which
// calls the same handler the real listener would), so this stub just has to be
// importable and hand back a no-op unsubscribe.
export interface NetInfoState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  type?: string;
}

type Listener = (state: NetInfoState) => void;

const listeners = new Set<Listener>();

const NetInfo = {
  addEventListener(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export default NetInfo;
