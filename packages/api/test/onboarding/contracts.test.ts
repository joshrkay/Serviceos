import { describe, it, expect } from 'vitest';
import {
  BusinessIdentityInputSchema,
  PackPickInputSchema,
  OnboardingStatusResponseSchema,
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
});

describe('PackPickInputSchema', () => {
  it('accepts hvac and plumbing only', () => {
    expect(PackPickInputSchema.safeParse({ packId: 'hvac' }).success).toBe(true);
    expect(PackPickInputSchema.safeParse({ packId: 'plumbing' }).success).toBe(true);
    expect(PackPickInputSchema.safeParse({ packId: 'electrical' }).success).toBe(false);
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
        { id: 'test_call' as const, status: 'pending' as const },
      ],
      currentStep: 'pack' as const,
      isComplete: false,
      voiceAgentLive: false,
    };
    expect(OnboardingStatusResponseSchema.parse(value)).toEqual(value);
  });
});
