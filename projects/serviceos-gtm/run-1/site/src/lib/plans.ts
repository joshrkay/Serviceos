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
  tagline: string;
  /** Env var name that supplies the Stripe Price ID for this plan. */
  priceEnvVar: `STRIPE_PRICE_ID_${'SOLO' | 'SHOP' | 'PRO'}`;
  featured?: boolean;
  features: string[];
}

export const TRIAL_PERIOD_DAYS = 14;

export const PLANS: Record<PlanId, Plan> = {
  solo: {
    id: 'solo',
    name: 'Solo',
    priceCents: 29900,
    priceLabel: '$299',
    tagline: 'Owner-operator, one truck.',
    priceEnvVar: 'STRIPE_PRICE_ID_SOLO',
    features: [
      /* COPY-TODO: real feature list */
      'Placeholder feature one',
      'Placeholder feature two',
      'Placeholder feature three',
    ],
  },
  shop: {
    id: 'shop',
    name: 'Shop',
    priceCents: 49900,
    priceLabel: '$499',
    tagline: 'Small crew, growing book of work.',
    priceEnvVar: 'STRIPE_PRICE_ID_SHOP',
    featured: true,
    features: [
      /* COPY-TODO: real feature list */
      'Everything in Solo',
      'Placeholder feature two',
      'Placeholder feature three',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceCents: 79900,
    priceLabel: '$799',
    tagline: 'Multi-crew operation running at volume.',
    priceEnvVar: 'STRIPE_PRICE_ID_PRO',
    features: [
      /* COPY-TODO: real feature list */
      'Everything in Shop',
      'Placeholder feature two',
      'Placeholder feature three',
    ],
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
