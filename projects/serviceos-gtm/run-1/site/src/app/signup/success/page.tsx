import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { SessionIdNote } from '@/components/SessionIdNote';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Your Trial Is Live — Rivet ServiceOS',
  description: 'Your 14-day Rivet trial is live. Here is what happens next, from business setup to your first AI-handled call.',
  path: '/signup/success',
});

const ONBOARDING_STEPS = [
  { title: 'Business setup', body: 'Confirm your shop details and service area.' },
  { title: 'Price book', body: 'Load what you charge, so estimates and invoices price themselves right.' },
  { title: 'Brand voice', body: "Set how the AI sounds on the phone — it's your shop's voice, not a robot's." },
  { title: 'Phone number', body: 'We provision your AI answering line, or connect your existing number.' },
  { title: 'Test call', body: 'Call in yourself and hear the AI answer, book, and hand you the summary.' },
];

export default function SignupSuccessPage() {
  // Preview build: NEXT_PUBLIC_APP_URL is unset, so hand-off points at the
  // explanatory /go-live-pending page. Production sets the real app URL.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '/go-live-pending';

  return (
    <Section as="div" className="pt-24">
      <div className="mx-auto max-w-lg text-center">
        <span
          aria-hidden
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-2xl text-success"
        >
          ✓
        </span>
        <h1 className="mt-6 font-display text-4xl font-bold text-fg">Your trial is live</h1>
        <p className="mt-4 text-fg-muted">
          14 days, full product, nothing charged until day 15. We&apos;ve sent a confirmation to
          your email.
        </p>
        <Suspense fallback={null}>
          <SessionIdNote />
        </Suspense>

        {/* Hand-off card to product onboarding. */}
        <div className="mt-10 rounded-lg border border-border bg-surface p-6 text-left">
          <h2 className="font-display text-lg font-semibold text-fg">What happens next</h2>
          <p className="mt-2 text-sm text-fg-muted">
            Five short steps get your AI phone agent live — most shops finish in under 48 hours.
          </p>
          <ol className="mt-4 space-y-3">
            {ONBOARDING_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3 text-sm text-fg">
                <span
                  aria-hidden
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-fg"
                >
                  {i + 1}
                </span>
                <span>
                  <span className="font-semibold">{step.title}.</span>{' '}
                  <span className="text-fg-muted">{step.body}</span>
                </span>
              </li>
            ))}
          </ol>
          <Link href={appUrl} className="btn-primary mt-6 w-full">
            Continue to setup
          </Link>
        </div>
      </div>
    </Section>
  );
}
