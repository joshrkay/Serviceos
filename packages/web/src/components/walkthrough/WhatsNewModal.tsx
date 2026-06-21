import { useEffect, useState } from 'react';
import { Sparkles, Check } from 'lucide-react';
import { Modal } from '../ui/modal';
import { Button } from '../ui/button';
import { track } from '../../lib/analytics';
import { getLocalFlag, setLocalFlag } from '../../lib/uiFlags';
import { RELEASES, latestReleaseId, WHATS_NEW_SEEN_KEY } from './whatsNew';

// Re-exported for callers (and tests) that import the key from this module.
export { WHATS_NEW_SEEN_KEY };

/**
 * "What's new" changelog. Shows whenever the newest release id differs from the
 * user's stored cursor, then records the newest id so it won't show again until
 * the next release.
 *
 * New-vs-existing gating lives entirely in WelcomeWalkthrough: it seeds this
 * cursor to the latest release for a brand-new account, so day one shows only
 * the welcome tour. Established users never get that seed, so they fall straight
 * into the "cursor !== latest → show" path here. This component therefore stays
 * pure-localStorage (no onboarding-status poll of its own).
 */
export function WhatsNewModal() {
  const latestId = latestReleaseId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!latestId) return;
    const lastSeen = getLocalFlag(WHATS_NEW_SEEN_KEY);
    if (lastSeen === latestId) return; // already up to date

    setOpen(true);
    track('announcement_shown', { releaseId: latestId });
  }, [latestId]);

  function dismiss() {
    if (latestId) setLocalFlag(WHATS_NEW_SEEN_KEY, latestId);
    track('announcement_dismissed', { releaseId: latestId ?? null });
    setOpen(false);
  }

  // Show every release newer than the one the user last saw (or all, first time).
  const lastSeen = getLocalFlag(WHATS_NEW_SEEN_KEY);
  const lastSeenIndex = lastSeen ? RELEASES.findIndex((r) => r.id === lastSeen) : -1;
  const toShow = lastSeenIndex === -1 ? RELEASES : RELEASES.slice(0, lastSeenIndex);

  return (
    <Modal
      open={open}
      onClose={dismiss}
      size="md"
      footer={
        <Button variant="primary" size="lg" onClick={dismiss}>
          Got it
        </Button>
      }
    >
      <div className="px-1 pt-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-900 text-white">
            <Sparkles size={18} />
          </span>
          <h2 className="text-lg font-semibold text-slate-900">What’s new in Rivet</h2>
        </div>

        <div className="mt-5 space-y-6">
          {toShow.map((release) => (
            <div key={release.id}>
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-medium text-slate-900">{release.title}</h3>
                <span className="shrink-0 text-xs text-slate-400">{release.date}</span>
              </div>
              <ul className="mt-2 space-y-2">
                {release.items.map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-slate-600">
                    <Check size={15} className="mt-0.5 shrink-0 text-green-600" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
