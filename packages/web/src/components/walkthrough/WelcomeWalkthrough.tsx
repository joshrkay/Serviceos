import { useEffect, useState } from 'react';
import { Phone, FileText, CreditCard, Moon, PartyPopper } from 'lucide-react';
import { useOnboardingStatus } from '../../hooks/useOnboardingStatus';
import { getLocalFlag, setLocalFlag } from '../../lib/uiFlags';
import { Walkthrough, type WalkStep } from './Walkthrough';
import { WHATS_NEW_SEEN_KEY, latestReleaseId } from './whatsNew';

/**
 * First-run product tour for a brand-new account. Surfaces once, the first
 * time a *new* owner reaches the app with onboarding complete, then never again
 * (persisted in localStorage). Introduces what Rivet now does on their behalf.
 *
 * This component is the single owner of the "brand-new account" decision: it
 * gates on account age (accountCreatedAt from the onboarding status), and when
 * it identifies a new account it seeds the what's-new cursor so day one shows
 * only this tour, not the changelog. Established users never hit that seed, so
 * WhatsNewModal shows them the changelog normally.
 */
export const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';

/** An account is "new" (eligible for the welcome tour) for this long after
 * creation. Comfortably covers signup → finish-onboarding, while excluding
 * established users on the release that ships these surfaces. */
const NEW_ACCOUNT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const STEPS: WalkStep[] = [
  {
    id: 'answers-calls',
    icon: <Phone size={22} />,
    title: 'Rivet answers your phone',
    body: 'Every call is picked up in your shop’s voice, qualified, and booked — even when you’re on a roof or under a sink.',
  },
  {
    id: 'drafts-quotes',
    icon: <FileText size={22} />,
    title: 'Quotes draft themselves',
    body: 'From the call and your price book, Rivet drafts the estimate. You approve or edit it with one tap on a text.',
  },
  {
    id: 'chases-invoices',
    icon: <CreditCard size={22} />,
    title: 'Invoices get sent and chased',
    body: 'The invoice goes out when the job’s done, and polite reminders go out until you’re paid. Your time-to-cash drops.',
  },
  {
    id: 'daily-digest',
    icon: <Moon size={22} />,
    title: 'One text at the end of the day',
    body: 'Your digest shows what got done, what got paid, and what Rivet wasn’t sure about — approve what matters in 30 seconds.',
  },
  {
    id: 'all-set',
    icon: <PartyPopper size={22} />,
    title: 'You’re all set',
    body: 'Rivet is live. Speak an action anytime, and check back here whenever you want the full picture.',
  },
];

export function WelcomeWalkthrough() {
  const { data } = useOnboardingStatus(30_000, true);
  const [seen, setSeen] = useState(() => getLocalFlag(WELCOME_SEEN_KEY) !== null);

  const isNewAccount =
    !!data?.accountCreatedAt &&
    Date.now() - Date.parse(data.accountCreatedAt) < NEW_ACCOUNT_MAX_AGE_MS;

  const visible = !seen && !!data?.isComplete && isNewAccount;

  // Seed the what's-new cursor for a brand-new account the first time we
  // identify it, so the changelog stays suppressed on day one (the welcome
  // tour is enough). Established users never reach this branch, so their
  // cursor stays null and WhatsNewModal shows them the changelog.
  useEffect(() => {
    if (isNewAccount && getLocalFlag(WHATS_NEW_SEEN_KEY) === null) {
      const latest = latestReleaseId();
      if (latest) setLocalFlag(WHATS_NEW_SEEN_KEY, latest);
    }
  }, [isNewAccount]);

  function finish() {
    setLocalFlag(WELCOME_SEEN_KEY);
    setSeen(true);
  }

  return (
    <Walkthrough
      open={visible}
      steps={STEPS}
      tourId="welcome"
      onComplete={finish}
      onDismiss={finish}
    />
  );
}
