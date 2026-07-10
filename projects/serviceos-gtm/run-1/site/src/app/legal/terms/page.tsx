import type { Metadata } from 'next';
import { Section } from '@/components/Section';
import { pageMetadata } from '@/lib/metadata';

export const metadata: Metadata = pageMetadata({
  title: 'Terms of Service (Draft) — Rivet ServiceOS',
  description: 'Draft terms of service for the Rivet trial and billing — not yet reviewed by counsel.',
  path: '/legal/terms',
});

export default function TermsPage() {
  return (
    <Section as="div" className="pt-16">
      <article className="mx-auto max-w-2xl">
        <p className="rounded border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-fg">
          Draft — not yet reviewed by counsel. Effective at production launch.
        </p>
        <h1 className="mt-6 font-display text-4xl font-bold text-fg">Terms of Service</h1>
        <p className="mt-2 text-sm text-fg-muted">Draft version — no effective date yet.</p>

        <div className="mt-8 space-y-6 text-fg-muted">
          <p>
            These draft terms govern your use of the Rivet ServiceOS trial and subscription. By
            starting a trial, you agree to a monthly subscription that begins after the 14-day free
            trial unless you cancel first.
          </p>

          <h2 className="font-display text-xl font-semibold text-fg">Trial &amp; billing</h2>
          <p>
            Every plan (Solo $299/mo, Shop $499/mo, Pro $799/mo) starts with a 14-day free trial. A
            card is required to start the trial. Nothing is charged until day 15. If you cancel
            before day 15, you pay nothing. If you do not cancel, your card is billed the plan
            price on day 15 and again every month until you cancel. There is no long-term contract
            and no early-termination fee.
          </p>

          <h2 className="font-display text-xl font-semibold text-fg">Acceptable use</h2>
          <p>
            Use Rivet for your own service business — don&apos;t resell access, attempt to
            reverse-engineer the AI systems, or use the service for anything unlawful. We can
            suspend accounts that violate this.
          </p>

          <h2 className="font-display text-xl font-semibold text-fg">No warranties</h2>
          <p>
            The service is provided &quot;as is&quot; without warranties of any kind, express or
            implied. Rivet is not liable for indirect, incidental, or consequential damages arising
            from your use of the service, to the maximum extent permitted by law.
          </p>

          <h2 className="font-display text-xl font-semibold text-fg">Contact</h2>
          <p>
            Questions about these draft terms: hello@rivet.example (TODO: replace with the real
            contact address before launch).
          </p>
        </div>
      </article>
    </Section>
  );
}
