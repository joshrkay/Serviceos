/**
 * Inbound caps for the public demo line.
 *
 * One public number is attached to a seeded demo tenant (scripts/attach-demo-number.ts),
 * so anyone can dial it. The guard is what keeps that safe: a per-caller
 * allowance and a daily total (both on the platform tenant's phone_rate_limits,
 * the same place the outbound demo call spends its visitor allowance), and a
 * short per-call time limit. Real tenants must never be touched by any of it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createDemoInboundGuard,
  demoLimitReachedTwiml,
  DEMO_INBOUND_CALLER_SCOPE,
  DEMO_INBOUND_TOTAL_SCOPE,
  DEMO_INBOUND_WINDOW_MS,
} from '../../src/demo/inbound-limits';
import { loadDemoInboundConfig, type DemoInboundConfig } from '../../src/demo/config';
import { DEMO_PLATFORM_TENANT_ID } from '../../src/demo/platform-tenant';
import { hashDemoPhone } from '../../src/demo/service';

const DEMO_TENANT = 'tenant-demo-plumbing-1';
const REAL_TENANT = 'tenant-real-acme';
const SECRET = 'test-demo-secret';
const ALICE = '+15125550101';
const BOB = '+15125550102';

/** A limiter with the real one's semantics: allow while the trailing count is under the limit. */
function fakeLimiter() {
  const counts = new Map<string, number>();
  const tryConsume = vi.fn(
    async (tenantId: string, scope: string, key: string, limit: number, _windowMs: number) => {
      const id = `${tenantId}|${scope}|${key}`;
      const n = counts.get(id) ?? 0;
      if (limit <= 0 || n >= limit) return false;
      counts.set(id, n + 1);
      return true;
    },
  );
  return { limiter: { tryConsume }, tryConsume, counts };
}

function build(
  opts: {
    env?: Record<string, string>;
    config?: DemoInboundConfig;
    isDemoTenant?: (id: string) => Promise<boolean>;
    limiter?: ReturnType<typeof fakeLimiter>;
  } = {},
) {
  const l = opts.limiter ?? fakeLimiter();
  const warn = vi.fn();
  const guard = createDemoInboundGuard({
    config: opts.config ?? loadDemoInboundConfig(opts.env ?? {}),
    isDemoTenant: opts.isDemoTenant ?? (async (id) => id === DEMO_TENANT),
    limiter: l.limiter,
    phoneKeySecret: SECRET,
    logger: { warn },
  });
  return { guard, ...l, warn };
}

describe('demo inbound guard — per-caller allowance', () => {
  it('allows a caller three calls, then refuses the fourth (default DEMO_INBOUND_PER_CALLER_DAILY)', async () => {
    const { guard } = build();
    for (let i = 0; i < 3; i++) {
      expect(await guard.check({ tenantId: DEMO_TENANT, from: ALICE })).toMatchObject({ demo: true, allowed: true });
    }
    expect(await guard.check({ tenantId: DEMO_TENANT, from: ALICE })).toEqual({
      demo: true,
      allowed: false,
      reason: 'caller_limit',
    });
  });

  it('honours DEMO_INBOUND_PER_CALLER_DAILY', async () => {
    const { guard } = build({ env: { DEMO_INBOUND_PER_CALLER_DAILY: '1' } });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: ALICE })).toMatchObject({ allowed: true });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: ALICE })).toMatchObject({
      allowed: false,
      reason: 'caller_limit',
    });
  });

  it('counts each caller on their own: a second number is unaffected by the first being at its limit', async () => {
    const { guard } = build({ env: { DEMO_INBOUND_PER_CALLER_DAILY: '1' } });
    await guard.check({ tenantId: DEMO_TENANT, from: ALICE });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: ALICE })).toMatchObject({ allowed: false });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: BOB })).toMatchObject({ allowed: true });
  });

  it('counts the same number written two ways as one caller', async () => {
    const { guard } = build({ env: { DEMO_INBOUND_PER_CALLER_DAILY: '1' } });
    await guard.check({ tenantId: DEMO_TENANT, from: '+15125550101' });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: '15125550101' })).toMatchObject({
      allowed: false,
      reason: 'caller_limit',
    });
  });

  it('keys the counter on the platform tenant, a 24 h window, and an HMAC of the number — never the number itself', async () => {
    const { guard, tryConsume } = build();
    await guard.check({ tenantId: DEMO_TENANT, from: ALICE });

    const [tenantId, scope, key, limit, windowMs] = tryConsume.mock.calls[0];
    expect(tenantId).toBe(DEMO_PLATFORM_TENANT_ID);
    expect(scope).toBe(DEMO_INBOUND_CALLER_SCOPE);
    expect(key).toBe(hashDemoPhone(ALICE, SECRET));
    expect(key).not.toContain('5125550101');
    expect(limit).toBe(3);
    expect(windowMs).toBe(DEMO_INBOUND_WINDOW_MS);
    expect(DEMO_INBOUND_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('demo inbound guard — daily total', () => {
  it('refuses once the day is full, whoever calls (default 50)', async () => {
    const { guard, counts } = build({ env: { DEMO_INBOUND_DAILY_TOTAL: '2' } });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: ALICE })).toMatchObject({ allowed: true });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: BOB })).toMatchObject({ allowed: true });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: '+15125550103' })).toEqual({
      demo: true,
      allowed: false,
      reason: 'daily_total',
    });
    expect(counts.get(`${DEMO_PLATFORM_TENANT_ID}|${DEMO_INBOUND_TOTAL_SCOPE}|all`)).toBe(2);
  });

  it('defaults the daily total to 50', async () => {
    const { guard, tryConsume } = build();
    await guard.check({ tenantId: DEMO_TENANT, from: ALICE });
    const totalCall = tryConsume.mock.calls.find((c) => c[1] === DEMO_INBOUND_TOTAL_SCOPE);
    expect(totalCall?.[3]).toBe(50);
  });

  it('a caller who is over their own limit never spends the shared total (one number cannot drain the day)', async () => {
    const { guard, counts } = build({ env: { DEMO_INBOUND_PER_CALLER_DAILY: '1', DEMO_INBOUND_DAILY_TOTAL: '5' } });
    for (let i = 0; i < 10; i++) await guard.check({ tenantId: DEMO_TENANT, from: ALICE });
    expect(counts.get(`${DEMO_PLATFORM_TENANT_ID}|${DEMO_INBOUND_TOTAL_SCOPE}|all`)).toBe(1);
  });
});

describe('demo inbound guard — only demo tenants', () => {
  it('a real tenant is not demo: nothing is consumed, nothing is refused', async () => {
    const { guard, tryConsume } = build({ env: { DEMO_INBOUND_PER_CALLER_DAILY: '1', DEMO_INBOUND_DAILY_TOTAL: '1' } });
    for (let i = 0; i < 5; i++) {
      expect(await guard.check({ tenantId: REAL_TENANT, from: ALICE })).toEqual({ demo: false });
    }
    expect(tryConsume).not.toHaveBeenCalled();
  });

  it('a failing demo check treats the call as ordinary (the billing gate still blocks an unbilled demo tenant) and consumes nothing', async () => {
    const { guard, tryConsume, warn } = build({
      isDemoTenant: async () => {
        throw new Error('db down');
      },
    });
    expect(await guard.check({ tenantId: REAL_TENANT, from: ALICE })).toEqual({ demo: false });
    expect(tryConsume).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('demo inbound guard — fails closed for the demo line', () => {
  it('refuses a demo call when the counters cannot be read', async () => {
    const limiter = fakeLimiter();
    limiter.tryConsume.mockRejectedValueOnce(new Error('db down'));
    const { guard, warn } = build({ limiter });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: ALICE })).toEqual({
      demo: true,
      allowed: false,
      reason: 'unavailable',
    });
    expect(warn).toHaveBeenCalled();
  });

  it('refuses every demo call when the inbound config is malformed, without reading any counter', async () => {
    const { guard, tryConsume } = build({ env: { DEMO_INBOUND_DAILY_TOTAL: 'nope' } });
    expect(await guard.check({ tenantId: DEMO_TENANT, from: ALICE })).toEqual({
      demo: true,
      allowed: false,
      reason: 'unavailable',
    });
    expect(tryConsume).not.toHaveBeenCalled();
  });

  it('still lets a real tenant through when the inbound config is malformed', async () => {
    const { guard } = build({ env: { DEMO_INBOUND_DAILY_TOTAL: 'nope' } });
    expect(await guard.check({ tenantId: REAL_TENANT, from: ALICE })).toEqual({ demo: false });
  });
});

describe('demo inbound guard — call duration', () => {
  it('limits a demo tenant to 180 s by default', async () => {
    const { guard } = build();
    expect(await guard.maxCallDurationMsFor(DEMO_TENANT)).toBe(180_000);
  });

  it('honours DEMO_INBOUND_MAX_SECONDS', async () => {
    const { guard } = build({ env: { DEMO_INBOUND_MAX_SECONDS: '60' } });
    expect(await guard.maxCallDurationMsFor(DEMO_TENANT)).toBe(60_000);
  });

  it('puts no limit on a real tenant', async () => {
    const { guard } = build();
    expect(await guard.maxCallDurationMsFor(REAL_TENANT)).toBeUndefined();
  });

  it('puts no limit on a tenant whose demo flag cannot be read', async () => {
    const { guard } = build({
      isDemoTenant: async () => {
        throw new Error('db down');
      },
    });
    expect(await guard.maxCallDurationMsFor(DEMO_TENANT)).toBeUndefined();
  });

  it('still limits a demo tenant to the default 180 s when the inbound config is malformed', async () => {
    const { guard } = build({ env: { DEMO_INBOUND_MAX_SECONDS: 'nope' } });
    expect(await guard.maxCallDurationMsFor(DEMO_TENANT)).toBe(180_000);
  });
});

describe('demo limit reached message', () => {
  it('is a polite spoken message followed by a hang-up', () => {
    const twiml = demoLimitReachedTwiml();
    expect(twiml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>')).toBe(true);
    expect(twiml).toMatch(/<Say[^>]*>[^<]*demo[^<]*limit[^<]*<\/Say>/i);
    expect(twiml.endsWith('<Hangup/></Response>')).toBe(true);
  });
});
