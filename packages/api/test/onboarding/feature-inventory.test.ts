/**
 * Per-feature named coverage for the 8-feature launch inventory.
 *
 * Each describe block references a feature in the launch spec by name and
 * asserts the REAL behavior that fulfils it, against this repo's actual
 * architecture (Vite/React-Router + Express + in-code migrations + Twilio;
 * see FUNNEL.md / DECISIONS.md for the spec→real mapping). Deeper coverage
 * lives in the feature-specific suites: activation (voice/activation.test.ts,
 * integration/onboarding-activation.test.ts), funnel events
 * (analytics.funnel.test.ts + component tests), webhook signature/idempotency
 * (test/webhooks/*, telephony/twilio-signature.test.ts), provisioning
 * isolation (integration/rls-tenant-isolation.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { deriveOnboardingStatus, type OnboardingFacts } from '../../src/onboarding/derive-status';
import {
  BusinessIdentityInputSchema,
  CalendarChoiceInputSchema,
  VoiceConfigInputSchema,
} from '../../src/onboarding/contracts';
import { VOICE_PRESETS } from '../../src/integrations/vapi/assistant-config';

function facts(over: Partial<OnboardingFacts> = {}): OnboardingFacts {
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
    ...over,
  };
}

const completeIdentity = {
  businessName: 'Acme HVAC',
  businessHours: { mon: { open: '08:00', close: '17:00' } },
  jobBufferMinutes: 30,
  hourlyRateCents: 15000,
};

describe('Feature 1 — Signup → account creation', () => {
  it('marks the signup step done once the tenant account exists', () => {
    const r = deriveOnboardingStatus(facts({ tenantExists: true }));
    expect(r.steps[0]).toEqual({ id: 'signup', status: 'done' });
  });
  it('surfaces tenant_id so signup_started/signup_completed can carry it', () => {
    const r = deriveOnboardingStatus(facts({ tenantId: 'tenant-xyz' }));
    expect(r.tenantId).toBe('tenant-xyz');
  });
});

describe('Feature 2 — Onboarding wizard: business profile step', () => {
  it('accepts a valid business profile fixture', () => {
    const r = BusinessIdentityInputSchema.safeParse({ ...completeIdentity, timezone: 'America/Chicago' });
    expect(r.success).toBe(true);
  });
  it('rejects invalid fixtures (empty name; sub-minimum hourly rate)', () => {
    expect(
      BusinessIdentityInputSchema.safeParse({ ...completeIdentity, businessName: '' }).success,
    ).toBe(false);
    expect(
      BusinessIdentityInputSchema.safeParse({ ...completeIdentity, hourlyRateCents: 50 }).success,
    ).toBe(false);
  });
  it('marks the business-profile (identity) step done — resumable from persisted fields', () => {
    const r = deriveOnboardingStatus(facts({ identity: completeIdentity }));
    expect(r.steps[1].status).toBe('done');
  });
  it('accepts the extended profile (address, ZIPs, services) and rejects malformed ZIPs', () => {
    expect(
      BusinessIdentityInputSchema.safeParse({
        ...completeIdentity,
        serviceAddress: '123 Main St',
        serviceAreaZips: ['78701', '78702'],
        servicesOffered: ['AC repair', 'furnace install'],
      }).success,
    ).toBe(true);
    expect(
      BusinessIdentityInputSchema.safeParse({ ...completeIdentity, serviceAreaZips: ['ABCDE'] }).success,
    ).toBe(false);
  });
});

describe('Feature 3 — Phone number provisioning (Twilio)', () => {
  it('marks the phone step done when Twilio provisioning reaches full_readiness', () => {
    const r = deriveOnboardingStatus(facts({ identity: completeIdentity, packActivated: true, twilioStatus: 'full_readiness' }));
    expect(r.steps.find((s) => s.id === 'phone')?.status).toBe('done');
  });
  it('surfaces a provisioning error so the phone step can show a retry', () => {
    const r = deriveOnboardingStatus(facts({ identity: completeIdentity, packActivated: true, twilioStatus: 'failed' }));
    const phone = r.steps.find((s) => s.id === 'phone');
    expect(phone?.status).toBe('error');
    expect(phone?.blockers).toContain('twilio_provisioning_failed');
  });
});

describe('Feature 4 — Voice agent configuration', () => {
  it('offers three ElevenLabs preset voices for the voice step', () => {
    expect(VOICE_PRESETS).toHaveLength(3);
  });
  it('validates a voice-config save (preset + optional greeting override)', () => {
    expect(VoiceConfigInputSchema.safeParse({ voiceId: 'adam' }).success).toBe(true);
    expect(VoiceConfigInputSchema.safeParse({ voiceId: 'adam', greeting: 'Hi!' }).success).toBe(true);
    expect(VoiceConfigInputSchema.safeParse({ voiceId: '' }).success).toBe(false);
  });
  it('marks the voice (ai_check) step done once the AI self-check passes', () => {
    const r = deriveOnboardingStatus(
      facts({ identity: completeIdentity, packActivated: true, twilioStatus: 'full_readiness', subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' }, aiConfigPresent: true, aiVerificationStatus: 'passed' }),
    );
    expect(r.steps.find((s) => s.id === 'ai_check')?.status).toBe('done');
  });
});

describe('Feature 5 — Calendar connection', () => {
  it('accepts google (OAuth) and builtin (skip) calendar choices, rejects others', () => {
    expect(CalendarChoiceInputSchema.safeParse({ provider: 'google' }).success).toBe(true);
    expect(CalendarChoiceInputSchema.safeParse({ provider: 'builtin' }).success).toBe(true);
    expect(CalendarChoiceInputSchema.safeParse({ provider: 'outlook' }).success).toBe(false);
  });
});

describe('Feature 6 — Test call flow', () => {
  it('marks test_call done (succeeded-eligible) once an inbound call is detected', () => {
    const r = deriveOnboardingStatus(facts({ inboundCallCount: 1 }));
    expect(r.steps.find((s) => s.id === 'test_call')?.status).toBe('done');
  });
  it('marks test_call skipped on the explicit skip path (no inbound call)', () => {
    const r = deriveOnboardingStatus(facts({ inboundCallCount: 0, testCallSkippedAt: new Date() }));
    expect(r.steps.find((s) => s.id === 'test_call')?.status).toBe('skipped');
  });
});

describe('Feature 7 — Activation tracking (first_real_call_received)', () => {
  it('surfaces activatedAt so the celebration banner can render once activation fires', () => {
    const when = new Date('2026-06-01T00:00:00Z');
    const r = deriveOnboardingStatus(facts({ activatedAt: when }));
    expect(r.activatedAt).toBe(when.toISOString());
  });
  it('omits activatedAt until activation has happened', () => {
    const r = deriveOnboardingStatus(facts({ activatedAt: null }));
    expect(r.activatedAt).toBeUndefined();
  });
});

describe('Feature 8 — Trial → paid conversion', () => {
  it('marks the billing step done when the subscription is trialing or active', () => {
    const trialing = deriveOnboardingStatus(facts({ subscription: { stripeSubscriptionId: 'sub_1', status: 'trialing' } }));
    expect(trialing.steps.find((s) => s.id === 'billing')?.status).toBe('done');
    const active = deriveOnboardingStatus(facts({ subscription: { stripeSubscriptionId: 'sub_1', status: 'active' } }));
    expect(active.steps.find((s) => s.id === 'billing')?.status).toBe('done');
  });
  it('surfaces past_due subscription status so the in-app payment banner can show', () => {
    const r = deriveOnboardingStatus(facts({ subscription: { stripeSubscriptionId: 'sub_1', status: 'past_due' } }));
    expect(r.subscriptionStatus).toBe('past_due');
  });
});
