// Resolve-time stub for react-native under the jsdom test env. RN's package
// entry doesn't resolve in the root-only CI lane, and we only need the host
// primitives + AppState for class-contract/hook tests — not the native
// runtime. Each primitive maps to a DOM element so @testing-library/react can
// render screens and assert the NativeWind `className` tap-target contract.
import { createElement, type ReactNode } from 'react';

type Props = Record<string, unknown> & { children?: ReactNode };

// Pass only DOM-meaningful props through to keep `className` assertions intact
// while avoiding React "unknown prop" warnings for RN-only props
// (accessibilityRole/Label, testID, etc.) — so real warnings stay visible.
const host =
  (tag: string) =>
  ({ children, className }: Props) =>
    createElement(tag, { className }, children as ReactNode);

export const View = host('div');
export const Text = host('span');
export const ScrollView = host('div');
export const ActivityIndicator = host('div');
export const RefreshControl = host('div');

// Maps an RN <Image source={{ uri }}/> to an <img src> so screen tests can
// assert the persisted gallery renders the server download URL.
export const Image = ({ source, accessibilityLabel, className }: Props) => {
  const uri =
    source && typeof source === 'object' ? (source as { uri?: string }).uri : undefined;
  return createElement('img', {
    className,
    src: uri,
    alt: (accessibilityLabel as string) ?? '',
  });
};

// Surfaces `behavior` as a data attribute so screen tests can assert the
// composer is wrapped in a keyboard-avoiding container with the right
// platform behavior (the native runtime can't be exercised under jsdom).
export const KeyboardAvoidingView = ({ children, className, behavior }: Props) =>
  createElement('div', { className, 'data-behavior': behavior as string }, children as ReactNode);

// Minimal Platform: tests run as iOS so `Platform.OS === 'ios'` branches are
// the rendered default. (`select` is intentionally omitted — no screen under
// test uses it; add it when one does.)
export const Platform = {
  OS: 'ios' as 'ios' | 'android' | 'web',
};

// Renders children only while `visible` — enough for sheet/dialog flows
// (LineItemSheet) to be exercised as plain DOM in screen tests.
export const Modal = ({ children, visible }: Props) =>
  visible ? createElement('div', { 'data-modal': 'true' }, children as ReactNode) : null;

export const TextInput = ({ onChangeText, value, className, placeholder }: Props) =>
  createElement('input', {
    className,
    placeholder,
    value: value ?? '',
    onChange: (e: { target: { value: string } }) =>
      typeof onChangeText === 'function' ? (onChangeText as (t: string) => void)(e.target.value) : undefined,
  });

export const Pressable = ({ children, onPress, onPressIn, onPressOut, disabled, className }: Props) => {
  const resolved =
    typeof children === 'function'
      ? (children as (s: { pressed: boolean }) => ReactNode)({ pressed: false })
      : children;
  return createElement(
    'button',
    { className, disabled, onClick: onPress, onMouseDown: onPressIn, onMouseUp: onPressOut },
    resolved as ReactNode,
  );
};

export function FlatList({ data, renderItem, keyExtractor, ListEmptyComponent }: Props) {
  const rows = Array.isArray(data) ? (data as unknown[]) : [];
  const children = rows.length
    ? rows.map((item, index) =>
        createElement(
          'div',
          { key: typeof keyExtractor === 'function' ? (keyExtractor as (i: unknown, n: number) => string)(item, index) : index },
          (renderItem as (a: { item: unknown; index: number }) => ReactNode)({ item, index }),
        ),
      )
    : typeof ListEmptyComponent === 'function'
      ? createElement(ListEmptyComponent as () => ReactNode)
      : (ListEmptyComponent as ReactNode);
  return createElement('div', null, children);
}

// Minimal AppState used by usePendingProposals. Tests can drive transitions
// through the registered listeners via the exported test helper.
type AppStateListener = (state: string) => void;
const listeners = new Set<AppStateListener>();
export const AppState = {
  currentState: 'active' as string,
  addEventListener: (_type: string, cb: AppStateListener) => {
    listeners.add(cb);
    return { remove: () => listeners.delete(cb) };
  },
};

/** Test-only: drive an AppState transition (e.g. background/active). */
export function __emitAppState(state: string): void {
  AppState.currentState = state;
  for (const cb of listeners) cb(state);
}

// Minimal Linking: screens open video download URLs through it. Tests spy on
// openURL via __setLinkingOpenURL; the default is a resolved no-op.
let openURLImpl: (url: string) => Promise<unknown> = async () => undefined;
export const Linking = {
  openURL: (url: string) => openURLImpl(url),
};

/** Test-only: swap the Linking.openURL implementation (e.g. a vi.fn spy). */
export function __setLinkingOpenURL(fn: (url: string) => Promise<unknown>): void {
  openURLImpl = fn;
}
