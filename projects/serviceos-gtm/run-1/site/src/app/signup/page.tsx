import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { SignupForm } from '@/components/SignupForm';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Start your free trial',
  description: 'Placeholder signup description.', // COPY-TODO
  path: '/signup',
});

export default function SignupPage() {
  return (
    <Section as="div" className="pt-16">
      <div className="mx-auto max-w-lg">
        <div className="text-center">
          <p className="eyebrow">Start free trial</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">
            {/* COPY-TODO */}Start your 14-day free trial
          </h1>
          <p className="mt-4 text-fg-muted">
            {/* COPY-TODO */}Placeholder reassurance line. Card required, cancel anytime.
          </p>
        </div>

        <div className="mt-10 rounded-lg border border-border bg-surface p-6 sm:p-8">
          <Suspense fallback={<p className="text-fg-muted">Loading…</p>}>
            <SignupForm />
          </Suspense>
        </div>
      </div>
    </Section>
  );
}
