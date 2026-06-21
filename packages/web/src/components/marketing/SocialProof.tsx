import { Quote, Users, ShieldCheck, MessageSquare } from 'lucide-react';
import {
  testimonials as defaultTestimonials,
  formatTestimonialDate,
  type Testimonial,
} from './socialProof';

/**
 * Conversion social-proof slot, placed after the trust/transparency section
 * (the highest-leverage position for proof on a long-form landing page).
 *
 * Honest by construction: Rivet is in early access and ships NO fabricated
 * quotes or metrics. When `testimonials` is empty (today) this renders an
 * early-access credibility block — talk-to-the-founders, the honest trial, and
 * data ownership. The moment real, attributable quotes land in socialProof.ts,
 * it switches to the testimonial grid automatically.
 *
 * `items` is injectable so tests can pin both branches without touching the
 * shipped (empty) data.
 */
export function SocialProof({
  items = defaultTestimonials,
}: {
  items?: Testimonial[];
}) {
  return (
    <section className="border-b border-slate-200 bg-slate-50">
      <div className="mx-auto max-w-6xl px-6 py-20">
        {items.length > 0 ? (
          <TestimonialGrid items={items} />
        ) : (
          <EarlyAccessProof />
        )}
      </div>
    </section>
  );
}

function TestimonialGrid({ items }: { items: Testimonial[] }) {
  return (
    <>
      <div className="text-center">
        <p className="text-sm uppercase tracking-widest text-slate-500">
          From the field
        </p>
        <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
          Operators who stopped dispatching from the attic.
        </h2>
      </div>
      <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((t) => (
          <figure
            key={`${t.name}-${t.city}-${t.quote.slice(0, 16)}`}
            className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6"
          >
            <Quote
              size={20}
              className="text-brand-accent"
              aria-hidden="true"
            />
            <blockquote className="mt-4 flex-1 text-sm leading-relaxed text-slate-700">
              {t.quote}
            </blockquote>
            <figcaption className="mt-5 border-t border-slate-100 pt-4 text-sm">
              <span className="font-medium text-slate-900">{t.name}</span>
              <span className="text-slate-500">
                {' · '}
                {t.trade}, {t.city}
              </span>
              {formatTestimonialDate(t.date) && (
                <span className="mt-0.5 block text-xs text-slate-400">
                  {formatTestimonialDate(t.date)}
                </span>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
    </>
  );
}

function EarlyAccessProof() {
  const pillars = [
    {
      icon: MessageSquare,
      title: 'Talk to the people building it',
      body:
        'You are not account #40,000 in a queue. Reach the founders directly, and the roadmap gets shaped by real shops with trucks on the road.',
    },
    {
      icon: ShieldCheck,
      title: 'Nothing charged for 14 days',
      body:
        'Start a full trial. Card held, nothing charged until day 15. Cancel anytime — there is no contract and no cancellation call.',
    },
    {
      icon: Users,
      title: 'Your data stays yours',
      body:
        'Export everything on request, leave whenever you want. No lock-in, no hostage-taking, no games.',
    },
  ];
  return (
    <>
      <div className="text-center">
        <p className="text-sm uppercase tracking-widest text-slate-500">
          Early access
        </p>
        <h2 className="mt-4 text-3xl font-medium tracking-tight text-slate-900 sm:text-4xl">
          Built with owner-operators, in the open.
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-slate-600">
          We are early, and we say so. Rather than paste testimonials we
          haven&apos;t earned yet, here is the deal we actually offer the first
          shops on board.
        </p>
      </div>
      <div className="mt-14 grid gap-6 md:grid-cols-3">
        {pillars.map((p) => (
          <div
            key={p.title}
            className="rounded-2xl border border-slate-200 bg-white p-6"
          >
            <div className="flex size-10 items-center justify-center rounded-xl bg-brand-accent text-brand-accent-foreground">
              <p.icon size={18} aria-hidden="true" />
            </div>
            <h3 className="mt-5 text-base font-medium text-slate-900">
              {p.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {p.body}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}
