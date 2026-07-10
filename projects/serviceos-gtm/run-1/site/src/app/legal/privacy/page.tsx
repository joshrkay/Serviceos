import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Privacy policy (draft)',
  description: 'Draft privacy policy for the Rivet marketing site — not yet reviewed by counsel.',
  path: '/legal/privacy',
});

export default function PrivacyPage() {
  return (
    <Section as="div" className="pt-16">
      <article className="mx-auto max-w-2xl">
        <p className="rounded border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-fg">
          Draft — not yet reviewed by counsel. Effective at production launch.
        </p>
        <h1 className="mt-6 font-display text-4xl font-bold text-fg">Privacy Policy</h1>
        <p className="mt-2 text-sm text-fg-muted">Draft version — no effective date yet.</p>

        <div className="mt-8 space-y-6 text-fg-muted">
          <p>
            This page covers the Rivet marketing and signup site only — the pages you are on right
            now (home, pricing, FAQ, comparison pages, and the trial signup flow). It does not
            cover the Rivet product itself, which has its own privacy terms once you are a
            customer.
          </p>

          <h2 className="font-display text-xl font-semibold text-fg">Information we collect</h2>
          <p>
            When you start a free trial, we collect what you type into the signup form: your
            business name, your name, your work email, your trade (HVAC, plumbing, or both), and
            the plan you choose. When you enter payment details to start the trial, your card
            information is collected and processed directly by Stripe, our payment processor — we
            do not store your card number ourselves.
          </p>
          <p>
            This marketing site does not run any analytics or tracking scripts. We do not use
            cookies to track you across visits, and we do not share your browsing activity on this
            site with advertisers.
          </p>

          <h2 className="font-display text-xl font-semibold text-fg">How we use it</h2>
          <p>
            We use your signup details to create your trial account, start billing through Stripe
            after the 14-day trial, send you account and onboarding emails, and hand you off to
            product onboarding. We do not sell your information.
          </p>

          <h2 className="font-display text-xl font-semibold text-fg">Payment processing</h2>
          <p>
            All billing is handled by Stripe. Stripe&apos;s own privacy policy governs how it
            handles your payment details; we only receive confirmation that a payment method was
            added and whether billing succeeded.
          </p>

          <h2 className="font-display text-xl font-semibold text-fg">Contact</h2>
          <p>
            Questions about this draft policy: hello@rivet.example (TODO: replace with the real
            contact address before launch).
          </p>
        </div>
      </article>
    </Section>
  );
}
