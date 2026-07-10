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
  // Only fetch /api/me once Clerk reports a signed-in session — this
  // component mounts outside the router, so an ungated fetch fires on
  // /login too and feeds the 401 loop when the API rejects tokens.
  const { me } = useMe({ enabled: isLoaded && isSignedIn === true });

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && userId) {
      const email = user?.primaryEmailAddress?.emailAddress;
      const emailDomain = email?.split('@')[1];
      identify(userId, {
        emailDomain: emailDomain ?? null,
      });

      // Identify the signed-in user to Pendo once /api/me data is available.
      // Guarded: the Pendo snippet is commonly blocked by ad blockers and
      // must never break auth-state handling.
      if (me && typeof pendo !== 'undefined' && pendo) {
        const firstName = user?.firstName ?? undefined;
        const lastName = user?.lastName ?? undefined;
        const fullName =
          firstName || lastName
            ? [firstName, lastName].filter(Boolean).join(' ')
            : undefined;

        try {
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
        } catch {
          // Pendo unavailable — analytics identity is best-effort.
        }
      }
    } else {
      resetIdentity();
      try {
        if (typeof pendo !== 'undefined' && pendo) pendo.clearSession();
      } catch {
        // Pendo unavailable — nothing to clear.
      }
    }
  }, [isLoaded, isSignedIn, userId, user, me]);

  return null;
}
