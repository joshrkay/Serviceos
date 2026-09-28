/**
 * Typed client for GET /api/onboarding/status — the status payload the
 * mobile setup-complete gate (`src/hooks/useOnboardingStatus.ts`) reads.
 * Accepts a `fetch`-shaped client (from `useApiClient`) so the Clerk JWT is
 * attached automatically; calls no hooks itself.
 *
 * Shapes mirror `packages/web/src/types/onboarding.ts` (whose source of
 * truth is `packages/api/src/onboarding/contracts.ts`); this client only
 * reads the status payload.
 */
import type { AuthedFetch } from './me';

export type OnboardingStepId =
  | 'signup'
  | 'identity'
  | 'pack'
  | 'phone'
  | 'billing'
  | 'ai_check'
  | 'test_call';

export type OnboardingStepStatus =
  | 'done'
  | 'current'
  | 'pending'
  | 'error'
  | 'skipped';

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStepStatus;
  blockers?: string[];
  metadata?: Record<string, unknown>;
}

export interface OnboardingStatusResponse {
  steps: OnboardingStep[];
  currentStep: OnboardingStepId | null;
  isComplete: boolean;
  voiceAgentLive: boolean;
  /** The tenant id. */
  tenantId: string;
  /** Mirror of tenants.subscription_status. */
  subscriptionStatus:
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | null;
  /** ISO-8601 timestamp of the 40-AI-minute trial upgrade nudge fire-event. */
  upgradePromptShownAt?: string;
  /** ISO-8601 timestamp of the activation milestone (first real inbound call). */
  activatedAt?: string;
  /** ISO-8601 timestamp of tenants.created_at. */
  accountCreatedAt?: string;
}

/** GET /api/onboarding/status — the tenant's onboarding step states. */
export async function fetchOnboardingStatus(
  client: AuthedFetch,
): Promise<OnboardingStatusResponse> {
  const res = await client('/api/onboarding/status');
  if (!res.ok) {
    throw new Error(`fetchOnboardingStatus: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as OnboardingStatusResponse;
}
