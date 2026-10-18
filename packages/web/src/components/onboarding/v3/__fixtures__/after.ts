import type { OnboardingStatusResponse, OnboardingStep, OnboardingStepId, OnboardingStepStatus } from '../../../../types/onboarding';

export const TENANT_ID = '00000000-0000-0000-0000-0000000000a1';

/** A JSON response, the way the API sends one. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * The two sellable plans as GET /api/onboarding/billing/plans returns them
 * (BillingPlanView, billing/subscription.ts; the numbers are CALL_PLAN_USAGE).
 */
export const PLANS = [
  { id: 'starter', name: 'Starter', amountCents: 7_900, currency: 'usd', interval: 'month', includedUsers: 2, includedAiMinutes: 20, overageCentsPerAiMinute: 125 },
  { id: 'growth', name: 'Growth', amountCents: 19_900, currency: 'usd', interval: 'month', includedUsers: 5, includedAiMinutes: 60, overageCentsPerAiMinute: 125 },
] as const;

/**
 * What the real API answers when Stripe is on but no plan price is set, which is
 * the hermetic environment CI and e2e/onboarding-v3.config.ts run in
 * (STRIPE_SECRET_KEY set, no STRIPE_*_PRICE_ID). Captured from the running
 * API; e2e/onboarding-v3-ready-readback.spec.ts asserts the same bodies against
 * the real routes, so this cannot drift unnoticed.
 */
export const HERMETIC_PLANS_503 = {
  error: 'BILLING_PLANS_UNAVAILABLE',
  message: 'No billing plans are currently configured. Contact support.',
};
export const HERMETIC_CHECKOUT_400 = {
  error: 'VALIDATION_ERROR',
  message: 'Billing plan "starter" is not configured (STRIPE_STARTER_PRICE_ID is not set). Contact support.',
};

const ORDER: OnboardingStepId[] = ['signup', 'identity', 'pack', 'billing', 'phone', 'ai_check', 'test_call'];

type StepPatch = Partial<Record<OnboardingStepId, Partial<OnboardingStep> & { status: OnboardingStepStatus }>>;

/**
 * An onboarding status as derive-status.ts builds it: every step before
 * `current` is done, `current` is the first step not done, the rest are pending.
 * `patch` overrides single steps (a blocker, metadata, a skip).
 */
export function statusAt(
  current: OnboardingStepId | null,
  patch: StepPatch = {},
  over: Partial<OnboardingStatusResponse> = {},
): OnboardingStatusResponse {
  const at = current === null ? ORDER.length : ORDER.indexOf(current);
  const steps = ORDER.map((id, i): OnboardingStep => {
    const base: OnboardingStep = { id, status: i < at ? 'done' : i === at ? 'current' : 'pending' };
    return { ...base, ...patch[id] };
  });
  return {
    steps,
    currentStep: current,
    isComplete: current === null,
    voiceAgentLive: false,
    tenantId: TENANT_ID,
    subscriptionStatus: at > ORDER.indexOf('billing') ? 'trialing' : null,
    ...over,
  };
}
