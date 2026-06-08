import { useEffect, useRef, useState } from 'react';
import { PartyPopper } from 'lucide-react';
import { useAuth } from '@clerk/clerk-react';
import { useOnboardingStatus } from '../../../hooks/useOnboardingStatus';
import { trackFunnel } from '../../../lib/analytics';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISS_KEY = 'onboarding.activation.dismissedAt';

/**
 * Activation celebration banner — the one-time "your AI just handled its
 * first real call" moment. Surfaces when the server has stamped
 * tenant_settings.activated_at (exposed as data.activatedAt) — the same
 * marker the first_real_call_received funnel event fires on.
 *
 * Mirrors UpgradeNudgeBanner's contract:
 *   - server timestamp is the source of truth for "did this happen"
 *   - local dismissal (localStorage) so it doesn't pester across reloads
 *   - auto-hides after 7 days so a long-lived tab never shows a stale party
 *
 * Fires activation_celebrated (the web side of the activation milestone)
 * exactly once, when the banner first becomes visible.
 */
export function ActivationCelebrationBanner() {
  const { userId } = useAuth();
  const { data } = useOnboardingStatus(60_000);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !!window.localStorage.getItem(DISMISS_KEY);
  });
  const celebratedRef = useRef(false);

  const activatedAt = data?.activatedAt;
  const activatedMs = activatedAt ? Date.parse(activatedAt) : Number.NaN;
  const withinWindow =
    !Number.isNaN(activatedMs) && Date.now() - activatedMs <= SEVEN_DAYS_MS;
  const visible = !!data && !!activatedAt && withinWindow && !dismissed;

  useEffect(() => {
    if (visible && !celebratedRef.current) {
      celebratedRef.current = true;
      trackFunnel('activation_celebrated', { tenantId: data?.tenantId ?? null, userId });
    }
  }, [visible, data?.tenantId, userId]);

  function dismiss() {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    }
    setDismissed(true);
  }

  if (!visible) return null;

  return (
    <div className="border-b border-green-300 bg-green-50 px-4 py-3 text-sm flex items-center gap-3">
      <PartyPopper size={16} className="shrink-0 text-green-700" />
      <div className="flex-1">
        <span className="font-semibold text-green-900">
          Your AI just handled its first real call.
        </span>{' '}
        <span className="text-green-800">
          Your agent is officially earning its keep — open the dashboard to see the
          transcript and any booking it made.
        </span>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="text-green-700 text-xs underline"
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}
