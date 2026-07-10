import Link from 'next/link';
import { PLANS, PLAN_ORDER, TRIAL_PERIOD_DAYS, type PlanId } from '@/lib/plans';

/**
 * The 3-tier pricing grid. Reused on /pricing (full) and the home teaser
 * (compact). CTAs deep-link into /signup with the plan preselected.
 *
 * Prices, ids, and the "featured" flag come from lib/plans.ts (wired to
 * Stripe — never edited here). The scale framing and feature list below are
 * owned by this component: every plan ships the full product, so the copy
 * differentiates tiers by shop size, not by feature-gating.
 */
const SCALE_COPY: Record<PlanId, string> = {
  solo: 'One truck, no employees. You are the only approver.',
  shop: '2–3 trucks, 1–2 techs. Enough calls to need routing, not enough to need an office.',
  pro: '4–6 trucks running at volume. More calls and more techs, same one-tap approvals.',
};

const FULL_FEATURE_LIST = [
  "The AI answers every call, 24/7, in your shop's voice — books what it can, patches emergencies straight to you",
  'Estimates and invoices drafted from the call, priced from your own price book',
  'Payment links, invoice follow-ups, and capped late fees, chased automatically',
  'Every AI action is a proposal you approve by text — nothing sends itself',
  'End-of-day digest: what got done, what got paid, what it was not sure about',
  'Google review requests and monitoring, with AI-drafted responses you approve',
];

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
                Most shops pick this
              </span>
            )}
            <h3 className="font-display text-xl font-bold text-fg">{plan.name}</h3>
            <p className="mt-1 text-sm text-fg-muted">{SCALE_COPY[id]}</p>
            <p className="mt-4 flex items-baseline gap-1">
              <span className="font-display text-4xl font-bold text-fg">{plan.priceLabel}</span>
              <span className="text-sm text-fg-muted">/mo</span>
            </p>
            <p className="mt-1 text-xs text-fg-muted">
              {TRIAL_PERIOD_DAYS}-day free trial &middot; card required &middot; not charged until day 15
            </p>

            {!compact && (
              <>
                <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-fg-muted">
                  Every plan is the full product
                </p>
                <ul className="mt-3 space-y-2 text-sm text-fg">
                  {FULL_FEATURE_LIST.map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <span aria-hidden className="text-success">
                        &#10003;
                      </span>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </>
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
