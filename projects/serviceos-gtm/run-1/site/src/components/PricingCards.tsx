import Link from 'next/link';
import { PLANS, PLAN_ORDER, TRIAL_PERIOD_DAYS } from '@/lib/plans';

/**
 * The 3-tier pricing grid. Reused on /pricing (full) and the home teaser
 * (compact). CTAs deep-link into /signup with the plan preselected.
 */
export function PricingCards({ compact = false }: { compact?: boolean }) {
  return (
    <div className="grid gap-6 md:grid-cols-3">
      {PLAN_ORDER.map((id) => {
        const plan = PLANS[id];
        return (
          <div
            key={plan.id}
            className={`relative flex flex-col rounded-lg border bg-surface p-6 ${
              plan.featured ? 'border-primary shadow-lg' : 'border-border'
            }`}
          >
            {plan.featured && (
              <span className="absolute -top-3 left-6 rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-fg">
                Most popular {/* COPY-TODO */}
              </span>
            )}
            <h3 className="font-display text-xl font-bold text-fg">{plan.name}</h3>
            <p className="mt-1 text-sm text-fg-muted">{plan.tagline}</p>
            <p className="mt-4 flex items-baseline gap-1">
              <span className="font-display text-4xl font-bold text-fg">{plan.priceLabel}</span>
              <span className="text-sm text-fg-muted">/mo</span>
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              {TRIAL_PERIOD_DAYS}-day free trial &middot; card required
            </p>

            {!compact && (
              <ul className="mt-6 space-y-2 text-sm text-fg">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <span aria-hidden className="text-success">
                      &#10003;
                    </span>
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-6 flex-1" />
            <Link
              href={`/signup?plan=${plan.id}`}
              className={plan.featured ? 'btn-primary w-full' : 'btn-secondary w-full'}
            >
              Start free trial
            </Link>
          </div>
        );
      })}
    </div>
  );
}
