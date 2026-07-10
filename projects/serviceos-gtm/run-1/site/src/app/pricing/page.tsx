import type { Metadata } from 'next';
import Link from 'next/link';
import { Section } from '@/components/Section';
import { PricingCards } from '@/components/PricingCards';
import { JsonLd } from '@/components/JsonLd';
import { pageMetadata } from '@/lib/metadata';
import { PLAN_ORDER, PLANS, TRIAL_PERIOD_DAYS } from '@/lib/plans';

export const metadata: Metadata = pageMetadata({
  title: 'Rivet Pricing — $299–$799/mo, 14-Day Free Trial',
  description:
    'Rivet costs $299–$799 a month, flat — no per-conversation fees like a standalone AI answering service. 14-day free trial, cancel anytime.',
  path: '/pricing',
});

const PRICING_FAQ = [
  {
    q: 'How does billing work?',
    a: 'You pick a plan and enter a card at signup. Nothing is charged for 14 days. On day 15, your card is billed the plan price and billing repeats monthly until you cancel.',
  },
  {
    q: 'What happens after the trial?',
    a: 'If you have not canceled, your card is charged the plan price on day 15 and every month after. You keep everything you set up during the trial — no re-onboarding.',
  },
  {
    q: 'How do I cancel?',
    a: 'Cancel from your account before day 15 and you are never charged. You can cancel any month after that too — there is no contract and no early-termination fee.',
  },
];

export default function PricingPage() {
  const productJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Rivet ServiceOS subscription',
    offers: PLAN_ORDER.map((id) => ({
      '@type': 'Offer',
      name: PLANS[id].name,
      price: (PLANS[id].priceCents / 100).toFixed(2),
      priceCurrency: 'USD',
    })),
  };

  return (
    <>
      <JsonLd data={productJsonLd} />
      <Section as="div" className="pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">Pricing</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">
            Rivet costs $299–$799 a month, flat
          </h1>
          <p className="mt-6 text-lg text-fg-muted">
            Solo is $299/mo, Shop is $499/mo, Pro is $799/mo — pick by how many trucks you run.
            Every plan gets the full product: the AI answers your phone, books the job, drafts the
            estimate and invoice, and chases the payment. There is no per-conversation fee and no
            add-on tier hiding the features you actually need.
          </p>
          <p className="mt-4 text-sm text-fg-muted">
            {TRIAL_PERIOD_DAYS}-day free trial on every plan. Card required, nothing charged until
            day 15, cancel anytime before that.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="plans-heading">
        <h2 id="plans-heading" className="sr-only">
          Plans
        </h2>
        <PricingCards />
      </Section>

      <Section aria-labelledby="roi-heading" className="bg-surface-muted">
        <div className="mx-auto max-w-2xl">
          <h2 id="roi-heading" className="text-center font-display text-3xl font-bold text-fg">
            Is it worth it?
          </h2>
          <p className="mt-6 text-lg text-fg-muted">
            Do the math yourself: if the AI books one job a month you would otherwise have missed —
            a call you couldn&rsquo;t answer in an attic, an estimate that would have slipped through
            the cracks — it pays for itself. Everything after that is margin.
          </p>
          <p className="mt-4 text-fg-muted">
            Compare it to the alternatives. A standalone AI answering service — just the phone,
            nothing else — typically runs $25–$65/month for a capped basic plan or $149–$299/month
            for a flat-rate unlimited one, with human-hybrid options running $255–$1,275+/month, per
            third-party AI-receptionist pricing surveys. That buys you a phone line. It does not
            draft the estimate, send the invoice, or chase the payment. And it costs more than a
            $299–$499 Rivet plan before it has done any of that back-office work at all. Weigh it
            against hiring even a part-time office manager to answer, book, quote, and invoice, and
            the math tips further in Rivet&rsquo;s favor.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="pricing-faq-heading">
        <h2 id="pricing-faq-heading" className="text-center font-display text-3xl font-bold text-fg">
          Pricing FAQ
        </h2>
        <dl className="mx-auto mt-10 max-w-2xl divide-y divide-border">
          {PRICING_FAQ.map((item) => (
            <div key={item.q} className="py-5">
              <dt className="font-semibold text-fg">{item.q}</dt>
              <dd className="mt-2 text-sm text-fg-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-10 text-center">
          <Link href="/signup" className="btn-primary">
            Start your 14-day free trial
          </Link>
        </div>
      </Section>
    </>
  );
}
