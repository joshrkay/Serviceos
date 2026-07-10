import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { DemoCheckout } from '@/components/DemoCheckout';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Demo checkout',
  description: 'Simulated checkout used when Stripe test keys are not configured.',
  path: '/signup/demo-checkout',
});

export default function DemoCheckoutPage() {
  return (
    <Section as="div" className="pt-16">
      <Suspense fallback={<p className="text-center text-fg-muted">Loading…</p>}>
        <DemoCheckout />
      </Suspense>
    </Section>
  );
}
