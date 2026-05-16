import { describe, it, expect } from 'vitest';
import { deriveOnboardingStatus, type OnboardingFacts } from '../../src/onboarding/derive-status';

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    tenantExists: true,
    identity: { businessName: null, businessHours: null, jobBufferMinutes: null, hourlyRateCents: null },
    packActivated: false,
    twilioStatus: null,
    subscription: { stripeSubscriptionId: null, status: null },
    inboundCallCount: 0,
    testCallSkippedAt: null,
    ...overrides,
  };
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

  it('subscription trialing: billing done, test_call current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true, twilioStatus: 'full_readiness',
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
    }));
    expect(r.steps[4].status).toBe('done');
    expect(r.steps[5].status).toBe('current');
  });

  it('inbound call recorded: test_call done, complete=true', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true, twilioStatus: 'full_readiness',
      subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' },
      inboundCallCount: 1,
    }));
    expect(r.steps[5].status).toBe('done');
    expect(r.isComplete).toBe(true);
    expect(r.currentStep).toBeNull();
  });

  it('intermediate twilio status (e.g., t0_requested): phone is current', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true,
      twilioStatus: 't0_requested',
    }));
    expect(r.steps[3].status).toBe('current');
  });

  it('test call skipped: test_call=skipped, complete=true', () => {
    const r = deriveOnboardingStatus(facts({
      identity: { businessName: 'A', businessHours: { mon: null }, jobBufferMinutes: 30, hourlyRateCents: 10000 },
      packActivated: true, twilioStatus: 'full_readiness',
      subscription: { stripeSubscriptionId: 'sub_1', status: 'active' },
      testCallSkippedAt: new Date(),
    }));
    expect(r.steps[5].status).toBe('skipped');
    expect(r.isComplete).toBe(true);
  });
});
