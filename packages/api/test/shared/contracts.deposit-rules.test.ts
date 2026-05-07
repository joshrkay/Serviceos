import { updateSettingsSchema } from '../../src/shared/contracts';

describe('updateSettingsSchema — Tier 4 Deposit rules cross-field refinement (PR 1)', () => {
  it('accepts a valid percentage rule with bps', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid fixed rule with cents', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'fixed',
      depositFixedCents: 50000,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an explicit null clear (all four deposit fields null)', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: null,
      depositPercentageBps: null,
      depositFixedCents: null,
      depositRequiredAboveCents: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects percentage strategy without depositPercentageBps', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'percentage',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('|');
      expect(messages).toMatch(/depositPercentageBps is required/);
    }
  });

  it('rejects fixed strategy without depositFixedCents', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'fixed',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join('|');
      expect(messages).toMatch(/depositFixedCents is required/);
    }
  });

  it('rejects bps > 10000 (over 100%)', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'percentage',
      depositPercentageBps: 12000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative depositFixedCents', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'fixed',
      depositFixedCents: -100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer depositPercentageBps (basis points must be integers)', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'percentage',
      depositPercentageBps: 2500.5,
    });
    expect(result.success).toBe(false);
  });

  it('accepts depositRequiredAboveCents alongside a percentage rule', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositRequiredAboveCents: 50000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative depositRequiredAboveCents', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositRequiredAboveCents: -1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts depositTimingPolicy "before_approval"', () => {
    const result = updateSettingsSchema.safeParse({
      depositStrategy: 'percentage',
      depositPercentageBps: 2500,
      depositTimingPolicy: 'before_approval',
    });
    expect(result.success).toBe(true);
  });

  it('accepts depositTimingPolicy "after_approval"', () => {
    const result = updateSettingsSchema.safeParse({
      depositTimingPolicy: 'after_approval',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown depositTimingPolicy value', () => {
    const result = updateSettingsSchema.safeParse({
      depositTimingPolicy: 'whenever',
    });
    expect(result.success).toBe(false);
  });
});
