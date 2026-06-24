import '../global.css';
import { ClerkLoaded, ClerkProvider, useAuth } from '@clerk/clerk-expo';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { CLERK_PUBLISHABLE_KEY } from '../src/lib/env';
import { tokenCache } from '../src/lib/tokenCache';
import { usePushRegistration } from '../src/hooks/usePushRegistration';
import { usePendingProposals } from '../src/hooks/usePendingProposals';
import { useNotificationRouter } from '../src/push/useNotificationRouter';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { ToastProvider } from '../src/components/Toast';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { AppChrome } from '../src/components/AppChrome';
import { PushStatusProvider } from '../src/push/pushStatusContext';

// Redirect between the auth flow and the app based on Clerk's session state.
function AuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Register this device for push once signed in (best-effort, fire-and-forget).
  // The outcome is published so Settings/Home can nudge when permission was denied.
  const pushStatus = usePushRegistration(Boolean(isSignedIn));
  // The approval-badge surface, mounted app-wide so a foreground push can
  // refresh it without the owner being on a particular screen. `refresh` is a
  // stable callback while enabled, so it's safe as the router's onForeground.
  const { refresh: refreshPendingProposals } = usePendingProposals({
    enabled: Boolean(isSignedIn),
  });
  // Deep-link a tapped push to its target screen; refresh the approvals surface
  // when a push lands while the app is already foregrounded.
  useNotificationRouter(refreshPendingProposals);

  useEffect(() => {
    if (!isLoaded) return;
    const inAuthGroup = segments[0] === '(auth)';
    if (!isSignedIn && !inAuthGroup) {
      router.replace('/sign-in');
    } else if (isSignedIn && inAuthGroup) {
      router.replace('/');
    }
  }, [isLoaded, isSignedIn, segments, router]);

  return (
    <PushStatusProvider status={pushStatus}>
      {/* The persistent tab bar + voice overlay live here, around the routed
          content, and only render once signed in. */}
      <AppChrome enabled={Boolean(isSignedIn)}>
        <Slot />
      </AppChrome>
    </PushStatusProvider>
  );
}

export default function RootLayout() {
  // Provider order, outermost first:
  //  - ErrorBoundary catches render throws anywhere below (incl. the toast/offline UI).
  //  - OfflineBanner sits above the routed tree as a persistent, full-width strip.
  //  - ToastProvider owns the transient action-error layer and the useToast() API
  //    (useApiClient raises the session-expired toast through it).
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      {/* Provides safe-area insets to the tab bar + voice overlay; initialMetrics
          avoids a first-frame flash before insets are measured. */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <StatusBar style="auto" />
        <ErrorBoundary>
          <ToastProvider>
            <View className="flex-1 bg-background">
              <OfflineBanner />
              <View className="flex-1">
                <ClerkLoaded>
                  <AuthGate />
                </ClerkLoaded>
              </View>
            </View>
          </ToastProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </ClerkProvider>
  );
}
