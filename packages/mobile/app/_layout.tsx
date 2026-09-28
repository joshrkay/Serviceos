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
import {
  isSetupGateSkippedForSession,
  useOnboardingStatus,
} from '../src/hooks/useOnboardingStatus';
import { useNotificationRouter } from '../src/push/useNotificationRouter';
import { useOfflineSync } from '../src/offline/useOfflineSync';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { ToastProvider } from '../src/components/Toast';
import { OfflineBanner } from '../src/components/OfflineBanner';
import { PushStatusProvider } from '../src/push/pushStatusContext';
import { TerminalProvider } from '../src/payments/TerminalProvider';

function AuthGate() {
  const { isLoaded, isSignedIn, userId } = useAuth();
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
  // Setup-complete gate (mobile mirror of web's OnboardingGuard in
  // ProtectedRoute): GET /api/onboarding/status; the CRM unlocks once the
  // business-identity step is done. Fails open — `isSetupComplete` is null
  // while loading or on a status outage, and the gate never redirects then.
  const onboarding = useOnboardingStatus(Boolean(isSignedIn));

  // Keep the setup verdict fresh as the owner moves: finishing onboarding in
  // the voice tab must unlock the CRM without an app restart. The hook
  // TTL-guards the refetch so rapid navigation doesn't spam the endpoint.
  useEffect(() => {
    if (isSignedIn) void onboarding.refetch();
  }, [isSignedIn, segments, onboarding.refetch]);

  useEffect(() => {
    if (!isLoaded) return;
    const inAuthGroup = segments[0] === '(auth)';
    const inOnboarding = segments[0] === '(onboarding)';
    if (!isSignedIn && !inAuthGroup) {
      router.replace('/sign-in');
    } else if (isSignedIn && inAuthGroup) {
      // Fresh sign-in with known-incomplete setup goes straight to onboarding
      // instead of flashing the CRM (and its failing API calls). Unknown
      // status (still loading) falls through to '/' — the gate branch below
      // redirects to /onboarding as soon as the status resolves.
      router.replace(onboarding.isSetupComplete === false ? '/onboarding' : '/');
    } else if (isSignedIn && inOnboarding) {
      // allow onboarding flow
    } else if (
      isSignedIn &&
      onboarding.isSetupComplete === false &&
      !isSetupGateSkippedForSession(userId)
    ) {
      // Setup-complete gate: incomplete setup routes to onboarding. An
      // explicit "Skip for now" is honored for the session so the gate can't
      // trap the owner in a skip -> bounce-back loop.
      router.replace('/onboarding');
    }
  }, [isLoaded, isSignedIn, userId, segments, router, onboarding.isSetupComplete]);

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
