import { useState } from 'react';
import { Phone, FileText, CreditCard, Moon, PartyPopper } from 'lucide-react';
import { useOnboardingStatus } from '../../hooks/useOnboardingStatus';
import { getLocalFlag, setLocalFlag } from '../../lib/uiFlags';
import { Walkthrough, type WalkStep } from './Walkthrough';

/**
 * First-run product tour for a brand-new account. Surfaces once, the first
 * time an owner reaches the app with onboarding complete, then never again
 * (persisted in localStorage). Introduces what Rivet now does on their behalf.
 *
 * The `WELCOME_SEEN_KEY` is also read by WhatsNewModal so a brand-new account
 * sees only this tour, not the changelog, on day one.
 */
export const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';

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

  const visible = !seen && !!data?.isComplete;

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
