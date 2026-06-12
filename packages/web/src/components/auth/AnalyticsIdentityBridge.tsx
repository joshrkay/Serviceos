/**
 * Mirrors Clerk auth state into the analytics layer.
 *
 * - Signed in:  identify(userId, { emailDomain? }) so funnel events
 *   attribute to a stable id across sessions.
 * - Signed out: reset() so the next user doesn't inherit traits in a
 *   shared browser.
 *
 * Also bridges auth state to Pendo:
 * - Signed in:  pendo.identify() with visitor + account metadata.
 * - Signed out: pendo.clearSession() to reset to anonymous visitor.
 *
 * Mounted once near the root of the app — see main.tsx.
 */
import { useEffect } from 'react';
import { useAuth, useUser } from '@clerk/clerk-react';
import { identify, resetIdentity } from '../../lib/analytics';
import { useMe } from '../../hooks/useMe';

export function AnalyticsIdentityBridge() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { user } = useUser();
  const { me } = useMe();

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && userId) {
      const email = user?.primaryEmailAddress?.emailAddress;
      const emailDomain = email?.split('@')[1];
      identify(userId, {
        emailDomain: emailDomain ?? null,
      });

      // Identify the signed-in user to Pendo once /api/me data is available.
      if (me) {
        const firstName = user?.firstName ?? undefined;
        const lastName = user?.lastName ?? undefined;
        const fullName =
          firstName || lastName
            ? [firstName, lastName].filter(Boolean).join(' ')
            : undefined;

        pendo.identify({
          visitor: {
            id: me.user_id,
            email: email ?? undefined,
            full_name: fullName,
            role: me.role,
            canFieldServe: me.can_field_serve,
            currentMode: me.current_mode,
          },
          account: {
            id: me.tenant_id,
          },
        });
      }
    } else {
      resetIdentity();
      pendo.clearSession();
    }
  }, [isLoaded, isSignedIn, userId, user, me]);

  return null;
}
