import '../global.css';
import { ClerkLoaded, ClerkProvider, useAuth } from '@clerk/clerk-expo';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { CLERK_PUBLISHABLE_KEY } from '../src/lib/env';
import { tokenCache } from '../src/lib/tokenCache';
import { usePushRegistration } from '../src/hooks/usePushRegistration';
import { usePendingProposals } from '../src/hooks/usePendingProposals';
import { useNotificationRouter } from '../src/push/useNotificationRouter';

// Redirect between the auth flow and the app based on Clerk's session state.
function AuthGate() {
  const { isLoaded, isSignedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // Register this device for push once signed in (best-effort, fire-and-forget).
  usePushRegistration(Boolean(isSignedIn));
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

  return <Slot />;
}

export default function RootLayout() {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <StatusBar style="auto" />
      <ClerkLoaded>
        <AuthGate />
      </ClerkLoaded>
    </ClerkProvider>
  );
}
