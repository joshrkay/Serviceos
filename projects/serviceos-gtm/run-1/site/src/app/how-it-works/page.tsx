import Link from 'next/link';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'How it works', // COPY-TODO refine
  description: 'Placeholder how-it-works description.', // COPY-TODO
  path: '/how-it-works',
});

const STEPS = [
  { title: 'COPY-TODO step one', body: 'COPY-TODO detailed explanation.' },
  { title: 'COPY-TODO step two', body: 'COPY-TODO detailed explanation.' },
  { title: 'COPY-TODO step three', body: 'COPY-TODO detailed explanation.' },
  { title: 'COPY-TODO step four', body: 'COPY-TODO detailed explanation.' },
];

export default function HowItWorksPage() {
  return (
    <>
      <Section as="div" className="pt-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="eyebrow">How it works</p>
          <h1 className="mt-4 font-display text-4xl font-bold text-fg">
            {/* COPY-TODO */}Placeholder page headline
          </h1>
          <p className="mt-6 text-lg text-fg-muted">{/* COPY-TODO */}Placeholder intro paragraph.</p>
        </div>
      </Section>

      <Section aria-labelledby="steps-heading" className="bg-surface-muted">
        <h2 id="steps-heading" className="sr-only">
          Steps
        </h2>
        <ol className="mx-auto max-w-3xl space-y-8">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-4 rounded-lg border border-border bg-surface p-6">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary font-bold text-primary-fg">
                {i + 1}
              </span>
              <div>
                <h3 className="font-display text-lg font-semibold text-fg">{step.title}</h3>
                <p className="mt-2 text-sm text-fg-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-10 text-center">
          <Link href="/signup" className="btn-primary">
            Start free trial
          </Link>
        </div>
      </Section>
    </>
  );
}
