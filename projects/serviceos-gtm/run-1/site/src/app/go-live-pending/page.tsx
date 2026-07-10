import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Go-live pending',
  description:
    'This preview build isn’t wired to the production app yet. At launch, this step hands off to product onboarding.',
  path: '/go-live-pending',
});

/**
 * Preview-only fallback. In production NEXT_PUBLIC_APP_URL points at the real
 * product onboarding; until that env var is set, the success page links here.
 */
export default function GoLivePendingPage() {
  return (
    <Section as="div" className="pt-24">
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-surface p-8 text-center">
        <p className="eyebrow">Preview build</p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-[-0.01em] text-fg">
          Almost there
        </h1>
        <p className="mt-4 leading-relaxed text-fg-muted">
          Straight talk: this preview isn’t wired to the production app yet. At launch, this step
          hands you straight into onboarding — where we set up your number, tune the AI to your
          shop’s voice, and run a test call.
        </p>
        <p className="mt-4 text-sm leading-relaxed text-fg-subtle">
          Under the hood, the{' '}
          <code className="data mx-1 rounded bg-surface-sunk px-1.5 py-0.5 text-sm">
            NEXT_PUBLIC_APP_URL
          </code>{' '}
          setting isn’t configured on this build. Once it is, the “Continue to setup” button on the
          success page takes new customers directly into the live product.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href="/how-it-works" className="btn-secondary">
            See how it works
          </Link>
          <Link href="/" className="btn-secondary">
            Back to home
          </Link>
        </div>
      </div>
    </Section>
  );
}
