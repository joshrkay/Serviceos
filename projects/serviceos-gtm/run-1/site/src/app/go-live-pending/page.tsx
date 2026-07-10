import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Go-live pending',
  description: 'The production app hand-off is connected at go-live.',
  path: '/go-live-pending',
});

/**
 * Preview-only fallback. In production NEXT_PUBLIC_APP_URL points at the real
 * product onboarding; until that env var is set, the success page links here.
 */
export default function GoLivePendingPage() {
  return (
    <Section as="div" className="pt-24">
      <div className="mx-auto max-w-xl rounded-lg border border-border bg-surface p-8 text-center">
        <h1 className="font-display text-3xl font-bold text-fg">Almost there</h1>
        <p className="mt-4 text-fg-muted">
          The production app hand-off is connected at go-live. In this preview build,
          <code className="mx-1 rounded bg-surface-muted px-1.5 py-0.5 text-sm">NEXT_PUBLIC_APP_URL</code>
          is not set yet, so onboarding into the live product is not wired.
        </p>
        <p className="mt-4 text-sm text-fg-muted">
          Once the app URL is configured, the &ldquo;Continue to setup&rdquo; button on the success page
          will take new customers straight into product onboarding.
        </p>
        <div className="mt-8">
          <Link href="/" className="btn-secondary">
            Back to home
          </Link>
        </div>
      </div>
    </Section>
  );
}
