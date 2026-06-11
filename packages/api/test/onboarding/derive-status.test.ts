import { describe, it, expect } from 'vitest';
import { deriveOnboardingStatus, type OnboardingFacts } from '../../src/onboarding/derive-status';

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    tenantExists: true,
    identity: { businessName: null, businessHours: null, jobBufferMinutes: null, hourlyRateCents: null },
    packActivated: false,
    twilioStatus: null,
    subscription: { stripeSubscriptionId: null, status: null },
    inboundCallCount: 0,
    testCallSkippedAt: null,
    voiceAgentLiveAt: null,
    activatedAt: null,
    aiConfigPresent: false,
    aiVerificationStatus: null,
    aiVerificationError: null,
    ...overrides,
  };
}

/** Facts with everything up to and including billing satisfied. */
function billingDoneFacts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return facts({
    identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
    packActivated: true,
    twilioStatus: 'full_readiness',
    subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
    ...overrides,
  });
}

describe('deriveOnboardingStatus', () => {
  it('fresh tenant: only signup done, identity is current', () => {
    const r = deriveOnboardingStatus(facts());
    expect(r.steps[0]).toEqual({ id: 'signup', status: 'done' });
    expect(r.steps[1]).toEqual({ id: 'identity', status: 'current' });
    expect(r.currentStep).toBe('identity');
    expect(r.isComplete).toBe(false);
  });

  it('identity done: pack becomes current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
    }));
    expect(r.steps[1].status).toBe('done');
    expect(r.steps[2].status).toBe('current');
    expect(r.currentStep).toBe('pack');
  });

  it('identity partial (no hourly rate): identity stays current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: null },
    }));
    expect(r.steps[1].status).toBe('current');
  });

  it('pack activated: phone becomes current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
    }));
    expect(r.steps[2].status).toBe('done');
    expect(r.steps[3].status).toBe('current');
  });

  it('phone provisioning: phone is current (not done)', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
      twilioStatus: 'provisioning',
    }));
    expect(r.steps[3].status).toBe('current');
  });

  it('phone full_readiness: billing becomes current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
      twilioStatus: 'full_readiness',
    }));
    expect(r.steps[3].status).toBe('done');
    expect(r.steps[4].status).toBe('current');
  });

  it('phone failed: phone is error with blocker', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
      twilioStatus: 'failed',
    }));
    expect(r.steps[3].status).toBe('error');
    expect(r.steps[3].blockers).toBeDefined();
  });

  it('subscription trialing: billing done, ai_check current', () => {
    const r = deriveOnboardingStatus(billingDoneFacts());
    expect(r.steps[4]).toEqual({ id: 'billing', status: 'done' });
    expect(r.steps[5].id).toBe('ai_check');
    expect(r.steps[5].status).toBe('current');
    expect(r.currentStep).toBe('ai_check');
  });

  it('ai_check passed: test_call becomes current', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'passed',
    }));
    expect(r.steps[5]).toEqual({ id: 'ai_check', status: 'done' });
    expect(r.steps[6].id).toBe('test_call');
    expect(r.steps[6].status).toBe('current');
    expect(r.currentStep).toBe('test_call');
  });

  it('ai_check running: current with verifying metadata', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'running',
    }));
    expect(r.steps[5].status).toBe('current');
    expect(r.steps[5].metadata).toEqual({ verifying: true });
  });

  it('ai_check failed with config: error + ai_verification_failed blocker', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'failed',
      aiVerificationError: 'boom',
    }));
    expect(r.steps[5].status).toBe('error');
    expect(r.steps[5].blockers).toEqual(['ai_verification_failed']);
    expect(r.steps[5].metadata).toEqual({ error: 'boom' });
  });

  it('ai_check failed without config: error + ai_config_missing blocker', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: false,
      aiVerificationStatus: 'failed',
    }));
    expect(r.steps[5].status).toBe('error');
    expect(r.steps[5].blockers).toEqual(['ai_config_missing']);
  });

  it('inbound call recorded but ai_check not passed: not complete', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({ inboundCallCount: 1 }));
    expect(r.isComplete).toBe(false);
    expect(r.currentStep).toBe('ai_check');
  });

  it('inbound call recorded and ai_check passed: test_call done, complete=true', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      aiConfigPresent: true,
      aiVerificationStatus: 'passed',
      inboundCallCount: 1,
    }));
    expect(r.steps[6].status).toBe('done');
    expect(r.isComplete).toBe(true);
    expect(r.currentStep).toBeNull();
  });

  it('has 7 steps in order', () => {
    const r = deriveOnboardingStatus(facts());
    expect(r.steps.map((s) => s.id)).toEqual([
      'signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call',
    ]);
  });

  it('intermediate twilio status (e.g., t0_requested): phone is current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
      twilioStatus: 't0_requested',
    }));
    expect(r.steps[3].status).toBe('current');
  });

  it('test call skipped (ai_check passed): test_call=skipped, complete=true', () => {
    const r = deriveOnboardingStatus(billingDoneFacts({
      subscription: { stripeSubscriptionId: 'sub_1', status: 'active' },
      aiConfigPresent: true,
      aiVerificationStatus: 'passed',
      testCallSkippedAt: new Date(),
    }));
    expect(r.steps[6].status).toBe('skipped');
    expect(r.isComplete).toBe(true);
  });
});
