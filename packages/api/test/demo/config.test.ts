import { describe, it, expect, afterEach } from 'vitest';
import { isDemoCallsEnabled, demoPoolPerTrade, isProductionEnv } from '../../src/demo/config';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('demo config — DEMO_CALLS_ENABLED (the kill switch)', () => {
  it('is off when unset', () => {
    delete process.env.DEMO_CALLS_ENABLED;
    expect(isDemoCallsEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', ' TRUE '])('reads %j as on', (v) => {
    process.env.DEMO_CALLS_ENABLED = v;
    expect(isDemoCallsEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'off', 'no', '', 'enabled', 'maybe'])('reads %j as off (fail closed)', (v) => {
    process.env.DEMO_CALLS_ENABLED = v;
    expect(isDemoCallsEnabled()).toBe(false);
  });
});

describe('demo config — DEMO_POOL_PER_TRADE', () => {
  it('defaults to 3', () => {
    delete process.env.DEMO_POOL_PER_TRADE;
    expect(demoPoolPerTrade()).toBe(3);
  });

  it('reads a positive integer', () => {
    process.env.DEMO_POOL_PER_TRADE = '5';
    expect(demoPoolPerTrade()).toBe(5);
  });

  it.each(['0', '-1', '2.5', 'three', ''])('refuses %j instead of guessing', (v) => {
    process.env.DEMO_POOL_PER_TRADE = v;
    expect(() => demoPoolPerTrade()).toThrow(/DEMO_POOL_PER_TRADE/);
  });
});

describe('demo config — production detection', () => {
  it.each(['production', 'prod'])('treats NODE_ENV=%s as production', (v) => {
    process.env.NODE_ENV = v;
    expect(isProductionEnv()).toBe(true);
  });

  it.each(['development', 'dev', 'test', 'staging', undefined])('treats NODE_ENV=%s as not production', (v) => {
    if (v === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = v;
    expect(isProductionEnv()).toBe(false);
  });
});

describe('demo config — the seed script refusal', () => {
  it('refuses in production while the switch is off', async () => {
    const { demoSeedRefusalReason } = await import('../../src/demo/config');
    process.env.NODE_ENV = 'production';
    delete process.env.DEMO_CALLS_ENABLED;
    expect(demoSeedRefusalReason()).toMatch(/DEMO_CALLS_ENABLED/);
    process.env.NODE_ENV = 'prod';
    expect(demoSeedRefusalReason()).toMatch(/production/);
  });

  it('allows production once the switch is on, and any other environment regardless', async () => {
    const { demoSeedRefusalReason } = await import('../../src/demo/config');
    process.env.NODE_ENV = 'production';
    process.env.DEMO_CALLS_ENABLED = 'true';
    expect(demoSeedRefusalReason()).toBeNull();
    process.env.NODE_ENV = 'staging';
    delete process.env.DEMO_CALLS_ENABLED;
    expect(demoSeedRefusalReason()).toBeNull();
  });
});
