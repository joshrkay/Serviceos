import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { JsonLd } from '@/components/JsonLd';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'FAQ',
  description: 'Placeholder FAQ description.', // COPY-TODO
  path: '/faq',
});

const FAQ_GROUPS = [
  {
    heading: 'Getting started', // COPY-TODO
    items: [
      { q: 'COPY-TODO: question one?', a: 'COPY-TODO answer one.' },
      { q: 'COPY-TODO: question two?', a: 'COPY-TODO answer two.' },
    ],
  },
  {
    heading: 'Billing & trial', // COPY-TODO
    items: [
      { q: 'How does the 14-day trial work?', a: 'COPY-TODO answer about the trial and card requirement.' },
      { q: 'COPY-TODO: billing question?', a: 'COPY-TODO answer.' },
    ],
  },
];

export default function FaqPage() {
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_GROUPS.flatMap((group) =>
      group.items.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    ),
  };

  return (
    <>
      <JsonLd data={faqJsonLd} />
      <Section as="div" className="pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">FAQ</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">Frequently asked questions</h1>
          <p className="mt-6 text-lg text-fg-muted">{/* COPY-TODO */}Placeholder FAQ intro.</p>
        </div>
      </Section>

      <Section aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="sr-only">
          All questions
        </h2>
        <div className="mx-auto max-w-2xl space-y-12">
          {FAQ_GROUPS.map((group) => (
            <div key={group.heading}>
              <h3 className="font-display text-xl font-bold text-fg">{group.heading}</h3>
              <dl className="mt-4 divide-y divide-border">
                {group.items.map((item) => (
                  <div key={item.q} className="py-5">
                    <dt className="font-semibold text-fg">{item.q}</dt>
                    <dd className="mt-2 text-sm text-fg-muted">{item.a}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
