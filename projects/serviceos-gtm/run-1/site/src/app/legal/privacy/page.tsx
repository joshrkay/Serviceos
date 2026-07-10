import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';
import { SITE_NAME } from '@/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Privacy Policy',
  description: 'Draft privacy policy placeholder.',
  path: '/legal/privacy',
});

export default function PrivacyPage() {
  return (
    <Section as="div" className="pt-16">
      <article className="mx-auto max-w-2xl">
        <p className="rounded border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-fg">
          DRAFT — this placeholder privacy policy is not legal advice and will be replaced before launch.
        </p>
        <h1 className="mt-6 font-display text-4xl font-bold text-fg">Privacy Policy</h1>
        <p className="mt-2 text-sm text-fg-muted">Last updated: DRAFT {/* COPY-TODO */}</p>

        <div className="mt-8 space-y-6 text-fg-muted">
          <p>
            {/* COPY-TODO: real policy */}
            {SITE_NAME} respects your privacy. This draft describes, in plain terms, the categories of data
            we intend to collect (account details, billing information handled by our payment processor, and
            basic usage analytics) and how we use them to operate the service.
          </p>
          <h2 className="font-display text-xl font-semibold text-fg">Information we collect</h2>
          <p>Placeholder: account and contact details you provide, and payment data processed by Stripe.</p>
          <h2 className="font-display text-xl font-semibold text-fg">How we use it</h2>
          <p>Placeholder: to provide the service, process billing, and communicate with you.</p>
          <h2 className="font-display text-xl font-semibold text-fg">Contact</h2>
          <p>Placeholder contact address. {/* COPY-TODO */}</p>
        </div>
      </article>
    </Section>
  );
}
