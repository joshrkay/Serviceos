import type {
  OnboardingStatusResponse,
  OnboardingStepId,
  OnboardingStepStatus,
} from './contracts';

export interface OnboardingFacts {
  tenantExists: boolean;
  identity: {
    businessName: string | null;
    businessHours: unknown | null;     // null OR an empty object {} both count as "not set"
    jobBufferMinutes: number | null;
    hourlyRateCents: number | null;
  };
  packActivated: boolean;
  twilioStatus: 'pending' | 'provisioning' | 'full_readiness' | 'failed' | null;
  subscription: {
    stripeSubscriptionId: string | null;
    status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | null;
  };
  inboundCallCount: number;
  testCallSkippedAt: Date | null;
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
    test_call: isTestCallDone(f) || isTestCallSkipped(f),
  };

  const order: OnboardingStepId[] = ['signup', 'identity', 'pack', 'phone', 'billing', 'test_call'];
  const firstNotDone = order.find((id) => !done[id]) ?? null;

  const steps = order.map((id): { id: OnboardingStepId; status: OnboardingStepStatus; blockers?: string[] } => {
    if (id === 'phone' && f.twilioStatus === 'failed') {
      return { id, status: 'error', blockers: ['twilio_provisioning_failed'] };
    }
    if (id === 'test_call' && isTestCallSkipped(f)) {
      return { id, status: 'skipped' };
    }
    if (done[id]) return { id, status: 'done' };
    if (id === firstNotDone) return { id, status: 'current' };
    return { id, status: 'pending' };
  });

  return {
    steps,
    currentStep: firstNotDone,
    isComplete: firstNotDone === null,
  };
}
