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
import { identify, groupTenant, resetIdentity } from '../../lib/analytics';
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
        // Person-level traits, available once /api/me resolves. Enums/flags
        // only — never PII. `me` may be null on the first pass (the effect
        // re-runs when it loads), so these are conditionally merged.
        ...(me
          ? {
              role: me.role,
              current_mode: me.current_mode,
              can_field_serve: me.can_field_serve,
            }
          : {}),
      });

      // Tenant group so every event rolls up per tenant. Only the thin
      // client-available trait (timezone) is seeded here; the authoritative
      // B2B traits (vertical, plan, subscription_status) are set server-side.
      if (me?.tenant_id) {
        groupTenant(me.tenant_id, me.timezone ? { timezone: me.timezone } : undefined);
      }

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
