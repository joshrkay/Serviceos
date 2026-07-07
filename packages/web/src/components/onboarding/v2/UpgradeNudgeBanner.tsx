import { useState } from 'react';
import { useApiClient } from '../../../lib/apiClient';
import { useOnboardingStatus } from '../../../hooks/useOnboardingStatus';
import { hasLocalFlag, setLocalFlag } from '../../../lib/uiFlags';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISS_KEY = 'onboarding.upgradeNudge.dismissedAt';

/**
 * §10 onboarding — one-time conversion banner. Surfaces when the
 * 30-minute trial-usage nudge has fired on the server. Owner clicks
 * "End trial and subscribe now" → POST /api/billing/end-trial-now,
 * which sets trial_end=now on the Stripe subscription and triggers
 * an immediate invoice.
 *
 * Dismissal is local (localStorage) so the banner doesn't pester
 * across reloads, but never resurrects after a dismissal. Server-side
 * onboarding_upgrade_prompt_shown_at remains the source of truth for
 * "did we surface this once".
 *
 * Hidden:
 *   - if upgradePromptShownAt is unset
 *   - if it fired > 7 days ago
 *   - if the user dismissed locally
 *   - if onboarding is incomplete (the banner belongs on the app,
 *     not on /onboarding itself)
 */
export function UpgradeNudgeBanner() {
  const apiFetch = useApiClient();
  const { data, refetch } = useOnboardingStatus(60_000);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => hasLocalFlag(DISMISS_KEY));

  if (!data || !data.isComplete) return null;
  if (!data.upgradePromptShownAt) return null;
  if (dismissed) return null;

  const shown = Date.parse(data.upgradePromptShownAt);
  if (Number.isNaN(shown) || Date.now() - shown > SEVEN_DAYS_MS) return null;

  function dismiss() {
    setLocalFlag(DISMISS_KEY);
    setDismissed(true);
  }

  async function upgrade() {
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch('/api/billing/end-trial-now', { method: 'POST' });
      if (!res.ok) {
        if (res.status === 409) {
          setError("No subscription found. Open Settings to start a trial first.");
        } else {
          setError(`HTTP ${res.status}`);
        }
        return;
      }
      dismiss();
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm flex items-center gap-3">
      <div className="flex-1">
        <span className="font-semibold text-amber-900">Your AI is earning.</span>{' '}
        <span className="text-amber-800">
          You've used 30 minutes of trial voice — lock in your subscription now to remove caps.
        </span>
        {error && <span className="ml-3 text-red-700">{error}</span>}
      </div>
      <button
        type="button"
        onClick={() => void upgrade()}
        disabled={pending}
        className="px-3 py-1.5 bg-amber-700 text-white rounded text-xs font-medium disabled:opacity-50"
      >
        {pending ? 'Working…' : 'End trial and subscribe now'}
      </button>
      <button
        type="button"
        onClick={dismiss}
        className="text-amber-700 text-xs underline"
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}
