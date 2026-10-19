/**
 * U7 demo-call module configuration (plan: "Configuration and alerts").
 *
 * Read from env here, not on `shared/config.ts`'s zod schema, so a bad value
 * closes only this module instead of aborting boot. Every reader fails
 * closed: an unparseable value is the same as "off" for the switch and a
 * thrown error (not a guess) for a number.
 */

const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * The kill switch. Off means the public demo routes answer 503
 * `DEMO_DISABLED`, the landing CTA shows one button and no demo worker
 * sweeps (S6-2 onwards read it per request and per tick). Same ON/OFF
 * vocabulary as `packages/web/src/lib/onboardingV3Flag.ts`.
 */
export function isDemoCallsEnabled(): boolean {
  const raw = process.env.DEMO_CALLS_ENABLED?.trim().toLowerCase();
  return raw !== undefined && ON.has(raw);
}

/** Pool size per trade for `scripts/seed-demo-tenants.ts` (default 3). */
export function demoPoolPerTrade(): number {
  const raw = process.env.DEMO_POOL_PER_TRADE;
  if (raw === undefined) return 3;
  const n = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 1) {
    throw new Error(`DEMO_POOL_PER_TRADE must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * `shared/config.ts` accepts both `production` and `prod` as the production
 * environment; the seed script refuses in either unless the switch is on.
 */
export function isProductionEnv(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'production' || env === 'prod';
}

/**
 * Why `scripts/seed-demo-tenants.ts` must not run, or null when it may.
 * In production the pool is seeded only once the demo call is switched on.
 */
export function demoSeedRefusalReason(): string | null {
  if (isProductionEnv() && !isDemoCallsEnabled()) {
    return 'refusing to seed demo tenants: NODE_ENV is production and DEMO_CALLS_ENABLED is not on';
  }
  return null;
}
