/**
 * D-044 / #1764 — the "no Business Profile yet" state of the Google Business
 * sheet: a short walkthrough instead of a dead end. Google's create flow and
 * verification happen on Google's side and only the owner can finish them,
 * so this links out and explains; the sheet re-checks on its own and hands
 * off to the location picker once a location appears.
 */
import { ExternalLink } from 'lucide-react';

/** Google's own "create a Business Profile" flow. */
export const GOOGLE_CREATE_PROFILE_URL = 'https://business.google.com/create';
/** Google's help page for the postcard / phone / video verification options. */
export const GOOGLE_VERIFY_HELP_URL = 'https://support.google.com/business/answer/7107242';

const STEPS: { title: string; detail: string }[] = [
  {
    title: 'Create your profile on Google',
    detail: 'Use the same Google account you connected here. Add your business name, service area and phone.',
  },
  {
    title: 'Verify it with Google',
    detail:
      'Google confirms you own the business by postcard, phone, text, email or a short video. You have to finish this yourself. A postcard can take about a week.',
  },
  {
    title: 'Come back here',
    detail: 'We check Google for you. Once your profile shows up, you pick it and you are done.',
  },
];

const LINK_CLASS =
  'inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm';

interface GoogleProfileWalkthroughProps {
  checking: boolean;
  onCheckAgain: () => void;
}

export function GoogleProfileWalkthrough({ checking, onCheckAgain }: GoogleProfileWalkthroughProps) {
  return (
    <div
      data-testid="googlebusiness-no-location"
      className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
    >
      <p className="text-sm text-amber-900">Waiting on Google</p>
      <p className="text-xs text-amber-800 mt-0.5">
        This Google account has no Business Profile yet. Here is how to get one:
      </p>
      <ol data-testid="googlebusiness-walkthrough-steps" className="mt-3 space-y-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-200 text-xs text-amber-900"
            >
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-sm text-amber-900 break-words">{step.title}</span>
              <span className="block text-xs text-amber-800 break-words">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-3 space-y-2">
        <a
          href={GOOGLE_CREATE_PROFILE_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="googlebusiness-create-profile"
          className={`${LINK_CLASS} bg-slate-900 text-white`}
        >
          Create my Google profile
          <ExternalLink size={14} aria-hidden />
        </a>
        <a
          href={GOOGLE_VERIFY_HELP_URL}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="googlebusiness-verify-help"
          className={`${LINK_CLASS} border border-amber-300 bg-white text-amber-900`}
        >
          How Google verifies you
          <ExternalLink size={14} aria-hidden />
        </a>
        <button
          type="button"
          onClick={onCheckAgain}
          disabled={checking}
          data-testid="googlebusiness-check-again"
          className="min-h-11 w-full rounded-xl border border-amber-300 bg-white px-4 text-sm text-amber-900 disabled:opacity-60"
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  );
}
