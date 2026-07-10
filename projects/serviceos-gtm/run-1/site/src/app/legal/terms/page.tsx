import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';
import { SITE_NAME } from '@/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Terms of Service',
  description: 'Draft terms of service placeholder.',
  path: '/legal/terms',
});

export default function TermsPage() {
  return (
    <Section as="div" className="pt-16">
      <article className="mx-auto max-w-2xl">
        <p className="rounded border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-fg">
          DRAFT — this placeholder terms of service is not legal advice and will be replaced before launch.
        </p>
        <h1 className="mt-6 font-display text-4xl font-bold text-fg">Terms of Service</h1>
        <p className="mt-2 text-sm text-fg-muted">Last updated: DRAFT {/* COPY-TODO */}</p>

        <div className="mt-8 space-y-6 text-fg-muted">
          <p>
            {/* COPY-TODO: real terms */}
            These draft terms govern your use of {SITE_NAME}. By starting a trial you agree to a monthly
            subscription that begins after the 14-day free trial unless canceled.
          </p>
          <h2 className="font-display text-xl font-semibold text-fg">Subscriptions & trials</h2>
          <p>Placeholder: 14-day free trial, card required, renews monthly, cancel anytime.</p>
          <h2 className="font-display text-xl font-semibold text-fg">Acceptable use</h2>
          <p>Placeholder acceptable-use terms.</p>
          <h2 className="font-display text-xl font-semibold text-fg">Contact</h2>
          <p>Placeholder contact address. {/* COPY-TODO */}</p>
        </div>
      </article>
    </Section>
  );
}
