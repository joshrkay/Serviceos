import '../global.css';
import {
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
  useFonts as useBricolage,
} from '@expo-google-fonts/bricolage-grotesque';
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  useFonts as useHanken,
} from '@expo-google-fonts/hanken-grotesk';
import { ClerkLoaded, ClerkProvider, useAuth } from '@clerk/clerk-expo';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { CLERK_PUBLISHABLE_KEY } from '../src/lib/env';
import { tokenCache } from '../src/lib/tokenCache';
import { usePushRegistration } from '../src/hooks/usePushRegistration';
import { usePendingProposals } from '../src/hooks/usePendingProposals';
import { useNotificationRouter } from '../src/push/useNotificationRouter';
import { useOfflineSync } from '../src/offline/useOfflineSync';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { ToastProvider } from '../src/components/Toast';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { PushStatusProvider } from '../src/push/pushStatusContext';
import { TerminalProvider } from '../src/payments/TerminalProvider';

function AuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const pushStatus = usePushRegistration(Boolean(isSignedIn));
  const { refresh: refreshPendingProposals } = usePendingProposals({
    enabled: Boolean(isSignedIn),
  });
  useNotificationRouter(refreshPendingProposals);
  // U12 — drain the offline queue (voice + capture-class approvals) on
  // reconnect/foreground; a permanent-drop re-fetches the inbox.
  useOfflineSync(Boolean(isSignedIn), refreshPendingProposals);

  useEffect(() => {
    if (!isLoaded) return;
    const inAuthGroup = segments[0] === '(auth)';
    const inOnboarding = segments[0] === '(onboarding)';
    if (!isSignedIn && !inAuthGroup) {
      router.replace('/sign-in');
    } else if (isSignedIn && inAuthGroup) {
      router.replace('/');
    } else if (isSignedIn && inOnboarding) {
      // allow onboarding flow
    }
  }, [isLoaded, isSignedIn, segments, router]);

  return (
    <PushStatusProvider status={pushStatus}>
      <TerminalProvider>
        <Slot />
      </TerminalProvider>
    </PushStatusProvider>
  );
}

function FontGate({ children }: { children: ReactNode }) {
  const [bricolageLoaded] = useBricolage({
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
  });
  const [hankenLoaded] = useHanken({
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
    HankenGrotesk_600SemiBold,
  });

  if (!bricolageLoaded || !hankenLoaded) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator />
      </View>
    );
  }

  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <StatusBar style="auto" />
      <ErrorBoundary>
        <ToastProvider>
          <View className="flex-1 bg-background">
            <OfflineBanner />
            <View className="flex-1">
              <ClerkLoaded>
                <FontGate>
                  <AuthGate />
                </FontGate>
              </ClerkLoaded>
            </View>
          </View>
        </ToastProvider>
      </ErrorBoundary>
    </ClerkProvider>
  );
}
