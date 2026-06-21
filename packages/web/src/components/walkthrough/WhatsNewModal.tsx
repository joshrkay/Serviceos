import { useEffect, useState } from 'react';
import { Sparkles, Check } from 'lucide-react';
import { Modal } from '../ui/modal';
import { Button } from '../ui/button';
import { track } from '../../lib/analytics';
import { getLocalFlag, setLocalFlag } from '../../lib/uiFlags';
import { RELEASES, latestReleaseId } from './whatsNew';
import { WELCOME_SEEN_KEY } from './WelcomeWalkthrough';

/**
 * "What's new" changelog for existing users. Surfaces the release notes the
 * user hasn't seen yet, then records the newest id so it won't show again
 * until the next release.
 *
 * Gating keeps the two surfaces from colliding:
 *   - A brand-new account (welcome tour not yet seen) gets its last-seen id
 *     initialized to the latest release and the modal stays hidden — day one
 *     is for the welcome tour, not the changelog.
 *   - Everyone else sees it whenever the latest release id differs from their
 *     stored last-seen id.
 */
export const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

export function WhatsNewModal() {
  const latestId = latestReleaseId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!latestId) return;
    const lastSeen = getLocalFlag(WHATS_NEW_SEEN_KEY);
    const welcomeSeen = getLocalFlag(WELCOME_SEEN_KEY) !== null;

    if (lastSeen === latestId) return; // already up to date

    // Brand-new account: suppress the changelog and treat the current release
    // as already seen, so only the welcome tour shows on day one.
    if (!welcomeSeen && lastSeen === null) {
      setLocalFlag(WHATS_NEW_SEEN_KEY, latestId);
      return;
    }

    setOpen(true);
    track('announcement_shown', { releaseId: latestId });
  }, [latestId]);

  function dismiss() {
    if (latestId) setLocalFlag(WHATS_NEW_SEEN_KEY, latestId);
    track('announcement_dismissed', { releaseId: latestId ?? null });
    setOpen(false);
  }

  // Show every release at/after the one the user last saw (or all, first time).
  const lastSeen = getLocalFlag(WHATS_NEW_SEEN_KEY);
  const lastSeenIndex = lastSeen ? RELEASES.findIndex((r) => r.id === lastSeen) : -1;
  const unseen = lastSeenIndex === -1 ? RELEASES : RELEASES.slice(0, lastSeenIndex);
  const toShow = unseen.length > 0 ? unseen : RELEASES.slice(0, 1);

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
