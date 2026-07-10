import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { PricingCards } from '@/components/PricingCards';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Placeholder home title', // COPY-TODO
  description: 'Placeholder home description.', // COPY-TODO
  path: '/',
});

const HOW_IT_WORKS = [
  { step: '1', title: 'COPY-TODO step one', body: 'COPY-TODO short explanation of the first step.' },
  { step: '2', title: 'COPY-TODO step two', body: 'COPY-TODO short explanation of the second step.' },
  { step: '3', title: 'COPY-TODO step three', body: 'COPY-TODO short explanation of the third step.' },
];

const FAQ_TEASER = [
  { q: 'COPY-TODO: common question one?', a: 'COPY-TODO short answer.' },
  { q: 'COPY-TODO: common question two?', a: 'COPY-TODO short answer.' },
  { q: 'COPY-TODO: common question three?', a: 'COPY-TODO short answer.' },
];

export default function HomePage() {
  return (
    <>
      {/* HERO */}
      <Section as="div" className="pt-16 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">{/* COPY-TODO */}Placeholder eyebrow</p>
          <h1 className="mt-4 font-display text-4xl font-bold leading-tight text-fg sm:text-5xl">
            {/* COPY-TODO: hero headline */}
            Placeholder hero headline that states the core promise
          </h1>
          <p className="mt-6 text-lg text-fg-muted">
            {/* COPY-TODO: hero subhead */}
            Placeholder subheadline describing who it is for and the outcome.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/signup" className="btn-primary w-full sm:w-auto">
              Start free trial
            </Link>
            <Link href="/how-it-works" className="btn-secondary w-full sm:w-auto">
              See how it works
            </Link>
          </div>
          <p className="mt-3 text-xs text-fg-muted">14-day free trial &middot; card required &middot; cancel anytime</p>
        </div>

        {/* VIDEO SLOT */}
        <div className="mx-auto mt-14 max-w-4xl">
          <div
            className="flex aspect-video w-full items-center justify-center rounded-lg border border-border bg-surface-muted"
            role="img"
            aria-label="Product demo video placeholder"
          >
            <span className="text-sm text-fg-muted">{/* COPY-TODO: embed demo video */}Video slot</span>
          </div>
        </div>
      </Section>

      {/* HOW-IT-WORKS STRIP */}
      <Section aria-labelledby="how-heading" className="bg-surface-muted">
        <h2 id="how-heading" className="text-center font-display text-3xl font-bold text-fg">
          {/* COPY-TODO */}How it works
        </h2>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {HOW_IT_WORKS.map((item) => (
            <div key={item.step} className="rounded-lg border border-border bg-surface p-6">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary font-bold text-primary-fg">
                {item.step}
              </span>
              <h3 className="mt-4 font-display text-lg font-semibold text-fg">{item.title}</h3>
              <p className="mt-2 text-sm text-fg-muted">{item.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center">
          <Link href="/how-it-works" className="btn-secondary">
            Full walkthrough
          </Link>
        </div>
      </Section>

      {/* PROOF / TRUST */}
      <Section aria-labelledby="proof-heading">
        <h2 id="proof-heading" className="text-center font-display text-3xl font-bold text-fg">
          {/* COPY-TODO */}Trusted by operators
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fg-muted">
          {/* COPY-TODO: trust subhead / stats */}Placeholder proof subhead.
        </p>
        <div className="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex h-16 items-center justify-center rounded border border-border bg-surface text-xs text-fg-muted"
            >
              {/* COPY-TODO: customer logo */}Logo
            </div>
          ))}
        </div>
      </Section>

      {/* PRICING TEASER */}
      <Section aria-labelledby="pricing-teaser-heading" className="bg-surface-muted">
        <h2 id="pricing-teaser-heading" className="text-center font-display text-3xl font-bold text-fg">
          Simple, honest pricing
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-fg-muted">
          {/* COPY-TODO */}Every plan includes a 14-day free trial.
        </p>
        <div className="mt-10">
          <PricingCards compact />
        </div>
        <div className="mt-8 text-center">
          <Link href="/pricing" className="btn-secondary">
            Compare plans
          </Link>
        </div>
      </Section>

      {/* FAQ TEASER */}
      <Section aria-labelledby="faq-teaser-heading">
        <h2 id="faq-teaser-heading" className="text-center font-display text-3xl font-bold text-fg">
          Questions, answered
        </h2>
        <dl className="mx-auto mt-10 max-w-2xl divide-y divide-border">
          {FAQ_TEASER.map((item) => (
            <div key={item.q} className="py-5">
              <dt className="font-semibold text-fg">{item.q}</dt>
              <dd className="mt-2 text-sm text-fg-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-8 text-center">
          <Link href="/faq" className="btn-secondary">
            All FAQs
          </Link>
        </div>
      </Section>

      {/* FINAL CTA */}
      <Section aria-labelledby="cta-heading">
        <div className="rounded-lg border border-border bg-primary px-6 py-14 text-center">
          <h2 id="cta-heading" className="font-display text-3xl font-bold text-primary-fg">
            {/* COPY-TODO: final CTA headline */}Ready to start?
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-primary-fg/90">
            {/* COPY-TODO */}Placeholder closing line.
          </p>
          <div className="mt-8">
            <Link href="/signup" className="btn-secondary">
              Start free trial
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
