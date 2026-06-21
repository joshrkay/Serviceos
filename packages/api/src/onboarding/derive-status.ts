import type {
  OnboardingStatusResponse,
  OnboardingStepId,
  OnboardingStepStatus,
} from './contracts';

export interface OnboardingFacts {
  /** The tenant these facts belong to — surfaced so the client can stamp
   * tenant_id onto funnel events without a separate /me round-trip. */
  tenantId: string;
  tenantExists: boolean;
  /** tenants.created_at — drives the client's new-account vs. existing-user
   * distinction (welcome tour vs. what's-new changelog). Optional so existing
   * fact fixtures don't need it. */
  tenantCreatedAt?: Date | null;
  identity: {
    businessName: string | null;
    businessHours: unknown | null;     // null OR an empty object {} both count as "not set"
    jobBufferMinutes: number | null;
    hourlyRateCents: number | null;
  };
  packActivated: boolean;
  twilioStatus: string | null;  // full set of tenant_integrations.status values; only 'full_readiness' and 'failed' have special handling
  /** Provisioned phone number in E.164 (from tenant_integrations.provider_data->>'phoneE164'). null until purchase completes. */
  twilioPhoneNumber?: string | null;
  subscription: {
    stripeSubscriptionId: string | null;
    status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | null;
  };
  inboundCallCount: number;
  testCallSkippedAt: Date | null;
  /** Timestamp of the one-time 30-minute upgrade prompt (when shown). null until trial usage crosses the threshold. */
  upgradePromptShownAt?: Date | null;
  voiceAgentLiveAt: Date | null;
  /** Timestamp of the first real inbound call (activation milestone). null
   * until first_real_call_received fires. Drives the celebration banner. */
  activatedAt: Date | null;
  /** True once a model is configured for the tenant (ai_model is non-null). */
  aiConfigPresent: boolean;
  /** State of the onboarding AI self-check written by the verify_ai worker. */
  aiVerificationStatus: 'pending' | 'running' | 'passed' | 'failed' | null;
  /** Last verification error message (when status is 'failed'). */
  aiVerificationError?: string | null;
}

const isIdentityDone = (i: OnboardingFacts['identity']): boolean =>
  !!i.businessName &&
  i.jobBufferMinutes !== null &&
  i.hourlyRateCents !== null &&
  i.businessHours !== null &&
  typeof i.businessHours === 'object' &&
  Object.keys(i.businessHours as object).length > 0;

const isBillingDone = (s: OnboardingFacts['subscription']): boolean =>
  !!s.stripeSubscriptionId && (s.status === 'trialing' || s.status === 'active');

const isTestCallDone = (f: OnboardingFacts): boolean => f.inboundCallCount > 0;
const isTestCallSkipped = (f: OnboardingFacts): boolean =>
  f.testCallSkippedAt !== null && f.inboundCallCount === 0;

export function deriveOnboardingStatus(f: OnboardingFacts): OnboardingStatusResponse {
  const done: Record<OnboardingStepId, boolean> = {
    signup:    f.tenantExists,
    identity:  isIdentityDone(f.identity),
    pack:      f.packActivated,
    phone:     f.twilioStatus === 'full_readiness',
    billing:   isBillingDone(f.subscription),
    ai_check:  f.aiVerificationStatus === 'passed',
    test_call: isTestCallDone(f) || isTestCallSkipped(f),
  };

  const order: OnboardingStepId[] = ['signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call'];
  const firstNotDone = order.find((id) => !done[id]) ?? null;

  const phoneMetadata = f.twilioPhoneNumber ? { phoneNumber: f.twilioPhoneNumber } : undefined;

  const steps = order.map((id): { id: OnboardingStepId; status: OnboardingStepStatus; blockers?: string[]; metadata?: Record<string, unknown> } => {
    if (id === 'phone' && f.twilioStatus === 'failed') {
      return { id, status: 'error', blockers: ['twilio_provisioning_failed'], ...(phoneMetadata ? { metadata: phoneMetadata } : {}) };
    }
    if (id === 'ai_check') {
      if (f.aiVerificationStatus === 'passed') {
        return { id, status: 'done' };
      }
      if (f.aiVerificationStatus === 'failed') {
        const blocker = f.aiConfigPresent ? 'ai_verification_failed' : 'ai_config_missing';
        return {
          id,
          status: 'error',
          blockers: [blocker],
          ...(f.aiVerificationError ? { metadata: { error: f.aiVerificationError } } : {}),
        };
      }
      if (id === firstNotDone) {
        return { id, status: 'current', metadata: { verifying: f.aiVerificationStatus === 'running' } };
      }
      return { id, status: 'pending' };
    }
    if (id === 'test_call' && isTestCallSkipped(f)) {
      return { id, status: 'skipped' };
    }
    if (done[id]) {
      return { id, status: 'done', ...(id === 'phone' && phoneMetadata ? { metadata: phoneMetadata } : {}) };
    }
    if (id === firstNotDone) {
      return { id, status: 'current', ...(id === 'phone' && phoneMetadata ? { metadata: phoneMetadata } : {}) };
    }
    return { id, status: 'pending' };
  });

  return {
    steps,
    currentStep: firstNotDone,
    isComplete: firstNotDone === null,
    voiceAgentLive: f.voiceAgentLiveAt != null,
    tenantId: f.tenantId,
    subscriptionStatus: f.subscription.status,
    ...(f.upgradePromptShownAt
      ? { upgradePromptShownAt: f.upgradePromptShownAt.toISOString() }
      : {}),
    ...(f.activatedAt ? { activatedAt: f.activatedAt.toISOString() } : {}),
    ...(f.tenantCreatedAt ? { accountCreatedAt: f.tenantCreatedAt.toISOString() } : {}),
  };
}
