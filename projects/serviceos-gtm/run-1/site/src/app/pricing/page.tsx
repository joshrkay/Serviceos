import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { PricingCards } from '@/components/PricingCards';
import { JsonLd } from '@/components/JsonLd';
import { pageMetadata } from '@/lib/metadata';
import { PLAN_ORDER, PLANS } from '@/lib/plans';
import { SITE_NAME } from '@/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Pricing',
  description: 'Placeholder pricing description — Solo $299, Shop $499, Pro $799.', // COPY-TODO
  path: '/pricing',
});

const FAQ = [
  { q: 'Do I need a card to start?', a: 'Yes — every plan starts a 14-day free trial and requires a card.' },
  { q: 'COPY-TODO pricing question two?', a: 'COPY-TODO answer.' },
  { q: 'COPY-TODO pricing question three?', a: 'COPY-TODO answer.' },
];

export default function PricingPage() {
  const productJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `${SITE_NAME} subscription`,
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
            One flat price per month {/* COPY-TODO refine */}
          </h1>
          <p className="mt-6 text-lg text-fg-muted">
            {/* COPY-TODO */}Every plan includes a 14-day free trial. Card required. Cancel anytime.
          </p>
        </div>
      </Section>

      <Section aria-labelledby="plans-heading">
        <h2 id="plans-heading" className="sr-only">
          Plans
        </h2>
        <PricingCards />
      </Section>

      <Section aria-labelledby="pricing-faq-heading" className="bg-surface-muted">
        <h2 id="pricing-faq-heading" className="text-center font-display text-3xl font-bold text-fg">
          Pricing FAQ
        </h2>
        <dl className="mx-auto mt-10 max-w-2xl divide-y divide-border">
          {FAQ.map((item) => (
            <div key={item.q} className="py-5">
              <dt className="font-semibold text-fg">{item.q}</dt>
              <dd className="mt-2 text-sm text-fg-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
