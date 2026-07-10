import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { SignupForm } from '@/components/SignupForm';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Start your free 14-day trial',
  description:
    'Start a 14-day free trial of Rivet. Card required, nothing charged until day 15, cancel in two clicks.',
  path: '/signup',
});

const REASSURANCE = [
  '14 days free, full product, no limited demo.',
  'Card required to start — nothing is charged until day 15.',
  'Cancel in two clicks before day 15 and you pay nothing.',
];

export default function SignupPage() {
  return (
    <Section as="div" className="pt-16">
      <div className="mx-auto max-w-lg">
        <div className="text-center">
          <p className="eyebrow">Start free trial</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">
            Start your 14-day free trial
          </h1>
          <p className="mt-4 text-fg-muted">
            Tell us about your shop and pick a plan. Setup takes about two minutes.
          </p>
        </div>

        <ul className="mt-8 space-y-3">
          {REASSURANCE.map((line) => (
            <li key={line} className="flex items-start gap-3 text-sm text-fg">
              <span aria-hidden className="mt-0.5 text-success">
                &#10003;
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>

        <div className="mt-10 rounded-lg border border-border bg-surface p-6 sm:p-8">
          <Suspense fallback={<p className="text-fg-muted">Loading…</p>}>
            <SignupForm />
          </Suspense>
        </div>

        <p className="mt-6 text-center text-xs text-fg-muted">
          Preview build — payments run in Stripe test mode.
        </p>
      </div>
    </Section>
  );
}
