/**
 * Mirrors Clerk auth state into the analytics layer.
 *
 * - Signed in:  identify(userId, { emailDomain? }) so funnel events
 *   attribute to a stable id across sessions.
 * - Signed out: reset() so the next user doesn't inherit traits in a
 *   shared browser.
 *
 * Mounted once near the root of the app — see main.tsx.
 */
import { useEffect } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { identify, resetIdentity } from '../../lib/analytics';

export function AnalyticsIdentityBridge() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { user } = useUser();

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && userId) {
      const email = user?.primaryEmailAddress?.emailAddress;
      const emailDomain = email?.split('@')[1];
      identify(userId, {
        emailDomain: emailDomain ?? null,
      });
    } else {
      resetIdentity();
    }
  }, [isLoaded, isSignedIn, userId, user]);

  return null;
}
