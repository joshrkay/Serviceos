import { describe, it, expect } from 'vitest';
import {
  BusinessIdentityInputSchema,
  PackPickInputSchema,
  OnboardingStatusResponseSchema,
  ProvisioningFailureCodeSchema,
} from '../../src/onboarding/contracts';

describe('BusinessIdentityInputSchema', () => {
  it('accepts a complete valid payload', () => {
    const result = BusinessIdentityInputSchema.safeParse({
      businessName: 'Acme HVAC',
      serviceAreaText: 'Austin, TX',
      serviceAreaRadius: 25,
      businessHours: {
        mon: { open: '08:00', close: '17:00' },
        tue: { open: '08:00', close: '17:00' },
        wed: { open: '08:00', close: '17:00' },
        thu: { open: '08:00', close: '17:00' },
        fri: { open: '08:00', close: '17:00' },
        sat: null,
        sun: null,
      },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
    });
    expect(result.success).toBe(true);
  });

  // #874 — the radius is tri-state: null is a valid, explicit "clear it"
  // (the Service-area editor's emptied field), while out-of-range numbers
  // stay rejected.
  it('accepts an explicit null serviceAreaRadius (clear) but still bounds numbers', () => {
    const base = {
      businessName: 'Acme HVAC',
      businessHours: {},
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
    };
    expect(
      BusinessIdentityInputSchema.safeParse({ ...base, serviceAreaRadius: null }).success,
    ).toBe(true);
    expect(
      BusinessIdentityInputSchema.safeParse({ ...base, serviceAreaRadius: 0 }).success,
    ).toBe(false);
    expect(
      BusinessIdentityInputSchema.safeParse({ ...base, serviceAreaRadius: 501 }).success,
    ).toBe(false);
  });

  // #1158 — the buffer may be omitted (keep what's stored; NULL = not
  // configured) so an echo-only surface never turns "unset" into 30. A
  // present value stays bounded.
  it('accepts an omitted jobBufferMinutes but still bounds a present one', () => {
    const base = { businessName: 'Acme HVAC', businessHours: {}, hourlyRateCents: 12500 };
    expect(BusinessIdentityInputSchema.safeParse(base).success).toBe(true);
    expect(BusinessIdentityInputSchema.safeParse({ ...base, jobBufferMinutes: 0 }).success).toBe(true);
    expect(BusinessIdentityInputSchema.safeParse({ ...base, jobBufferMinutes: 241 }).success).toBe(false);
    expect(BusinessIdentityInputSchema.safeParse({ ...base, jobBufferMinutes: -1 }).success).toBe(false);
  });

  it('rejects empty business name', () => {
    const result = BusinessIdentityInputSchema.safeParse({
      businessName: '',
      businessHours: {},
      jobBufferMinutes: 30,
      hourlyRateCents: 10000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects hourly_rate_cents below 100', () => {
    const result = BusinessIdentityInputSchema.safeParse({
      businessName: 'A',
      businessHours: {},
      jobBufferMinutes: 30,
      hourlyRateCents: 50,
    });
    expect(result.success).toBe(false);
  });

  it('rejects bad business_hours time format', () => {
    const result = BusinessIdentityInputSchema.safeParse({
      businessName: 'A',
      businessHours: { mon: { open: '8am', close: '5pm' } },
      jobBufferMinutes: 30,
      hourlyRateCents: 10000,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional timezone', () => {
    const result = BusinessIdentityInputSchema.safeParse({
      businessName: 'A',
      businessHours: {},
      jobBufferMinutes: 30,
      hourlyRateCents: 10000,
      timezone: 'America/Phoenix',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an optional ownerPhone in any human format', () => {
    // The schema stays liberal in what it accepts — normalization to
    // E.164 happens in the route handler via normalizeMobileE164.
    for (const phone of [
      '(512) 555-1234',
      '512-555-1234',
      '+15125551234',
      '5125551234',
    ]) {
      const result = BusinessIdentityInputSchema.safeParse({
        businessName: 'A',
        businessHours: {},
        jobBufferMinutes: 30,
        hourlyRateCents: 10000,
        ownerPhone: phone,
      });
      expect(result.success, `expected ${phone} to parse`).toBe(true);
    }
  });

  it('rejects an absurdly long ownerPhone', () => {
    const result = BusinessIdentityInputSchema.safeParse({
      businessName: 'A',
      businessHours: {},
      jobBufferMinutes: 30,
      hourlyRateCents: 10000,
      ownerPhone: '+1' + '5'.repeat(60),
    });
    expect(result.success).toBe(false);
  });
});

describe('PackPickInputSchema', () => {
  it('accepts every supported trade', () => {
    for (const packId of [
      'hvac',
      'plumbing',
      'electrical',
      'roofing',
      'painting',
      'gc_remodel',
      'landscaping',
      'concrete',
      'other',
    ]) {
      expect(PackPickInputSchema.safeParse({ packId }).success).toBe(true);
    }
  });

  it('rejects unknown pack ids', () => {
    expect(PackPickInputSchema.safeParse({ packId: 'garbage' }).success).toBe(false);
  });

  it('accepts an optional free-text trade label for "other"', () => {
    expect(
      PackPickInputSchema.safeParse({ packId: 'other', tradeLabel: 'Pool service' }).success,
    ).toBe(true);
  });

  it('trims and bounds the trade label', () => {
    const parsed = PackPickInputSchema.safeParse({ packId: 'other', tradeLabel: '  Pool service  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tradeLabel).toBe('Pool service');
    expect(PackPickInputSchema.safeParse({ packId: 'other', tradeLabel: '' }).success).toBe(false);
    expect(
      PackPickInputSchema.safeParse({ packId: 'other', tradeLabel: 'x'.repeat(81) }).success,
    ).toBe(false);
  });
});

describe('OnboardingStatusResponseSchema', () => {
  it('round-trips a complete response', () => {
    const value = {
      steps: [
        { id: 'signup' as const, status: 'done' as const },
        { id: 'identity' as const, status: 'done' as const },
        { id: 'pack' as const, status: 'current' as const },
        { id: 'phone' as const, status: 'pending' as const },
        { id: 'billing' as const, status: 'pending' as const },
        { id: 'ai_check' as const, status: 'pending' as const },
        { id: 'test_call' as const, status: 'pending' as const },
      ],
      currentStep: 'pack' as const,
      isComplete: false,
      voiceAgentLive: false,
      tenantId: '00000000-0000-0000-0000-000000000001',
      subscriptionStatus: 'trialing' as const,
    };
    expect(OnboardingStatusResponseSchema.parse(value)).toEqual(value);
  });
});

describe('OnboardingStatusResponseSchema — draft.execution', () => {
  const steps = ['signup', 'identity', 'pack', 'phone', 'billing', 'ai_check', 'test_call'].map((id) => ({
    id: id as 'signup',
    status: 'pending' as const,
  }));
  const base = {
    steps,
    currentStep: 'identity' as const,
    isComplete: false,
    voiceAgentLive: false,
    tenantId: '00000000-0000-0000-0000-000000000001',
    subscriptionStatus: null,
  };
  const draft = { status: 'approved' as const, choicesAnswered: 7, version: 3 };

  it.each(['pending', 'executing', 'executed', 'failed', 'stopped', null] as const)('parses execution %s', (execution) => {
    expect(OnboardingStatusResponseSchema.parse({ ...base, draft: { ...draft, execution } }).draft?.execution).toBe(execution);
  });

  it('parses a draft without execution (older clients and fixtures)', () => {
    expect(OnboardingStatusResponseSchema.safeParse({ ...base, draft }).success).toBe(true);
  });

  it('rejects an unknown execution value and a steps array that is not seven long', () => {
    expect(OnboardingStatusResponseSchema.safeParse({ ...base, draft: { ...draft, execution: 'weird' } }).success).toBe(false);
    expect(OnboardingStatusResponseSchema.safeParse({ ...base, steps: steps.slice(0, 6) }).success).toBe(false);
  });
});

describe('OnboardingStatusResponseSchema — the phone step\'s failureCode (S5b-1)', () => {
  const ids = ['signup', 'identity', 'pack', 'billing', 'phone', 'ai_check', 'test_call'] as const;
  const response = (phone: Record<string, unknown>) => ({
    steps: ids.map((id) => (id === 'phone' ? { id, ...phone } : { id, status: 'done' })),
    currentStep: 'phone',
    isComplete: false,
    voiceAgentLive: false,
    tenantId: '00000000-0000-0000-0000-000000000001',
    subscriptionStatus: 'trialing',
  });

  it('exports the four codes as a schema', () => {
    expect(ProvisioningFailureCodeSchema.options).toEqual(['area_code_unavailable', 'credentials_missing', 'provider_error', 'unknown']);
  });

  it.each(['area_code_unavailable', 'credentials_missing', 'provider_error', 'unknown'] as const)(
    'parses a failed phone step carrying %s, and keeps it',
    (failureCode) => {
      const parsed = OnboardingStatusResponseSchema.parse(
        response({ status: 'error', failureCode, blockers: ['twilio_provisioning_failed'], metadata: { lineState: 'failed' } }),
      );
      expect(parsed.steps[4]).toEqual({ id: 'phone', status: 'error', failureCode, blockers: ['twilio_provisioning_failed'], metadata: { lineState: 'failed' } });
    },
  );

  it('parses a response without failureCode (an older server, a step that did not fail)', () => {
    const parsed = OnboardingStatusResponseSchema.parse(response({ status: 'error', blockers: ['twilio_provisioning_failed'] }));
    expect(parsed.steps[4]).not.toHaveProperty('failureCode');
    expect(OnboardingStatusResponseSchema.safeParse(response({ status: 'current', metadata: { lineState: 'claiming' } })).success).toBe(true);
  });

  it('rejects a failureCode outside the four, and the steps stay exactly seven', () => {
    expect(OnboardingStatusResponseSchema.safeParse(response({ status: 'error', failureCode: 'rate_limited' })).success).toBe(false);
    expect(OnboardingStatusResponseSchema.safeParse(response({ status: 'error', failureCode: '' })).success).toBe(false);
    const eight = response({ status: 'error', failureCode: 'unknown' });
    expect(OnboardingStatusResponseSchema.safeParse({ ...eight, steps: [...eight.steps, { id: 'signup', status: 'done' }] }).success).toBe(false);
  });

  it('every other step keeps its shape: id, status, optional blockers and metadata', () => {
    const parsed = OnboardingStatusResponseSchema.parse({
      ...response({ status: 'error', failureCode: 'provider_error' }),
      steps: ids.map((id) =>
        id === 'phone'
          ? { id, status: 'error', failureCode: 'provider_error' }
          : id === 'ai_check'
            ? { id, status: 'error', blockers: ['ai_verification_failed'], metadata: { error: 'x' } }
            : { id, status: 'pending' },
      ),
    });
    expect(parsed.steps.filter((s) => s.id !== 'phone')).toEqual([
      { id: 'signup', status: 'pending' },
      { id: 'identity', status: 'pending' },
      { id: 'pack', status: 'pending' },
      { id: 'billing', status: 'pending' },
      { id: 'ai_check', status: 'error', blockers: ['ai_verification_failed'], metadata: { error: 'x' } },
      { id: 'test_call', status: 'pending' },
    ]);
  });
});
