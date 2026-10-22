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

describe('demo config — loadDemoConfig (S6-2: read once at boot, a bad value closes only the module)', () => {
  const errors: string[] = [];
  const logger = {
    error: (msg: string) => {
      errors.push(msg);
    },
  };
  afterEach(() => {
    errors.length = 0;
  });

  it('uses the plan defaults when nothing is set, frozen', async () => {
    const { loadDemoConfig } = await import('../../src/demo/config');
    const config = loadDemoConfig({}, logger);
    expect(config).toEqual({
      open: true,
      settings: {
        callsDailyCap: 50,
        costDailyCapCents: 2500,
        callEstCostCents: 50,
        poolPerTrade: 3,
        statusTokenTtlHours: 24,
        resetBatchRows: 1000,
        resetDrainSeconds: 90,
      },
    });
    if (!config.open) throw new Error('unreachable');
    expect(Object.isFrozen(config.settings)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('reads every value', async () => {
    const { loadDemoConfig } = await import('../../src/demo/config');
    const config = loadDemoConfig(
      {
        DEMO_CALLS_DAILY_CAP: '7',
        DEMO_COST_DAILY_CAP_CENTS: '175',
        DEMO_CALL_EST_COST_CENTS: ' 25 ',
        DEMO_POOL_PER_TRADE: '2',
        DEMO_STATUS_TOKEN_TTL_HOURS: '12',
        DEMO_RESET_BATCH_ROWS: '500',
        DEMO_RESET_DRAIN_SECONDS: '30',
      },
      logger,
    );
    expect(config).toEqual({
      open: true,
      settings: {
        callsDailyCap: 7,
        costDailyCapCents: 175,
        callEstCostCents: 25,
        poolPerTrade: 2,
        statusTokenTtlHours: 12,
        resetBatchRows: 500,
        resetDrainSeconds: 30,
      },
    });
  });

  it.each([
    ['DEMO_CALLS_DAILY_CAP', 'fifty'],
    ['DEMO_CALLS_DAILY_CAP', '0'],
    ['DEMO_CALLS_DAILY_CAP', '-3'],
    ['DEMO_COST_DAILY_CAP_CENTS', '25.00'],
    ['DEMO_COST_DAILY_CAP_CENTS', ''],
    ['DEMO_CALL_EST_COST_CENTS', '0'],
    ['DEMO_CALL_EST_COST_CENTS', '1e2'],
    ['DEMO_POOL_PER_TRADE', '0'],
    ['DEMO_STATUS_TOKEN_TTL_HOURS', '-24'],
    ['DEMO_RESET_BATCH_ROWS', 'lots'],
    ['DEMO_RESET_DRAIN_SECONDS', '0'],
    ['DEMO_CALLS_DAILY_CAP', '2147483648'],
  ])('%s=%j closes the module with one error log, naming the variable', async (name, value) => {
    const { loadDemoConfig } = await import('../../src/demo/config');
    const config = loadDemoConfig({ [name]: value }, logger);
    expect(config.open).toBe(false);
    if (config.open) throw new Error('unreachable');
    expect(config.reason).toContain(name);
    expect(errors).toHaveLength(1);
  });

  it('a per-call estimate above the cost cap closes the module rather than guessing', async () => {
    const { loadDemoConfig } = await import('../../src/demo/config');
    const config = loadDemoConfig({ DEMO_COST_DAILY_CAP_CENTS: '40', DEMO_CALL_EST_COST_CENTS: '50' }, logger);
    expect(config).toEqual({
      open: false,
      reason: expect.stringMatching(/DEMO_CALL_EST_COST_CENTS.*DEMO_COST_DAILY_CAP_CENTS/),
    });
    expect(errors).toHaveLength(1);
  });

  it('an estimate equal to the cost cap is allowed (one call fits)', async () => {
    const { loadDemoConfig } = await import('../../src/demo/config');
    expect(loadDemoConfig({ DEMO_COST_DAILY_CAP_CENTS: '50', DEMO_CALL_EST_COST_CENTS: '50' }, logger).open).toBe(true);
  });

  it('does not read the kill switch: DEMO_CALLS_ENABLED stays a per-request read', async () => {
    const { loadDemoConfig } = await import('../../src/demo/config');
    expect(loadDemoConfig({ DEMO_CALLS_ENABLED: 'false' }, logger).open).toBe(true);
  });
});
