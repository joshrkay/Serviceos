/**
 * Plan catalog. Prices are FINAL (monthly, USD, 14-day free trial, card required).
 * Money is expressed in integer cents everywhere (never floating point).
 */

export type PlanId = 'solo' | 'shop' | 'pro';

export interface Plan {
  id: PlanId;
  name: string;
  priceCents: number;
  priceLabel: string;
  /** Env var name that supplies the Stripe Price ID for this plan. */
  priceEnvVar: `STRIPE_PRICE_ID_${'SOLO' | 'SHOP' | 'PRO'}`;
  featured?: boolean;
}

export const TRIAL_PERIOD_DAYS = 14;

// Note: the plan differentiator is shop size, not feature-gating — every plan
// ships the full product. The per-tier scale copy and the shared feature list
// live in PricingCards.tsx, so this catalog carries only pricing + Stripe wiring.
export const PLANS: Record<PlanId, Plan> = {
  solo: {
    id: 'solo',
    name: 'Solo',
    priceCents: 29900,
    priceLabel: '$299',
    priceEnvVar: 'STRIPE_PRICE_ID_SOLO',
  },
  shop: {
    id: 'shop',
    name: 'Shop',
    priceCents: 49900,
    priceLabel: '$499',
    priceEnvVar: 'STRIPE_PRICE_ID_SHOP',
    featured: true,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceCents: 79900,
    priceLabel: '$799',
    priceEnvVar: 'STRIPE_PRICE_ID_PRO',
  },
};

export const PLAN_ORDER: PlanId[] = ['solo', 'shop', 'pro'];
export const DEFAULT_PLAN: PlanId = 'shop';

export function isPlanId(value: unknown): value is PlanId {
  return value === 'solo' || value === 'shop' || value === 'pro';
}

export function getPlan(value: unknown): Plan {
  return isPlanId(value) ? PLANS[value] : PLANS[DEFAULT_PLAN];
}

export const VERTICALS = ['HVAC', 'Plumbing', 'Both'] as const;
export type Vertical = (typeof VERTICALS)[number];

export function isVertical(value: unknown): value is Vertical {
  return value === 'HVAC' || value === 'Plumbing' || value === 'Both';
}
