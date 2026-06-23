import { type ReactNode } from 'react';
import { View } from 'react-native';
import { usePathname } from 'expo-router';
import { TabBar } from './TabBar';
import { VoiceOverlay } from './VoiceOverlay';

// The shared app shell that hosts the persistent bottom tab bar and the
// contextual voice overlay around the routed content (`<Slot/>`). Mounted once
// in app/_layout.tsx so navigation chrome is set in one place rather than
// per-screen.

/** Immersive routes hide the tab bar (and mic): the auth flow, the proposal
 *  approval machine, and a message thread (whose composer owns the bottom). */
export function isImmersiveRoute(pathname: string): boolean {
  return (
    pathname.startsWith('/sign-in') ||
    pathname.startsWith('/proposals/') ||
    pathname.startsWith('/messages/')
  );
}

/** The mic shows on every non-immersive screen except the dedicated voice
 *  screen, where the full hold-to-talk surface already is the screen. */
export function shouldShowMic(pathname: string): boolean {
  return !isImmersiveRoute(pathname) && pathname !== '/voice';
}

export function AppChrome({
  enabled,
  children,
}: {
  /** Only show chrome when signed in; the auth flow renders bare. */
  enabled: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const showTabBar = enabled && !isImmersiveRoute(pathname);
  const showMic = enabled && shouldShowMic(pathname);

  return (
    <View className="flex-1">
      <View className="flex-1">{children}</View>
      {showTabBar ? <TabBar /> : null}
      {/* Rendered last so the mic + its sheet paint above content and tab bar. */}
      {showMic ? <VoiceOverlay /> : null}
    </View>
  );
}
