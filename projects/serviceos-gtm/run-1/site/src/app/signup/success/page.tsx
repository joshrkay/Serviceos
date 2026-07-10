import { Suspense } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { SessionIdNote } from '@/components/SessionIdNote';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Your trial is live',
  description: 'Trial started successfully.',
  path: '/signup/success',
});

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
        <h1 className="mt-6 font-display text-4xl font-bold text-fg">Your 14-day trial is live</h1>
        <p className="mt-4 text-fg-muted">
          {/* COPY-TODO */}Placeholder confirmation copy. We have sent a confirmation to your email.
        </p>
        <Suspense fallback={null}>
          <SessionIdNote />
        </Suspense>

        {/* Hand-off card to product onboarding. */}
        <div className="mt-10 rounded-lg border border-border bg-surface p-6 text-left">
          <h2 className="font-display text-lg font-semibold text-fg">Next: set up your account</h2>
          <p className="mt-2 text-sm text-fg-muted">
            {/* COPY-TODO */}Continue into the product to finish onboarding your team and catalog.
          </p>
          <Link href={appUrl} className="btn-primary mt-4 w-full">
            Continue to setup
          </Link>
        </div>
      </div>
    </Section>
  );
}
