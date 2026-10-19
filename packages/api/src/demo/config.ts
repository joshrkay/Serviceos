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

/** Postgres INTEGER: the budget columns and every count the module writes. */
const PG_INT_MAX = 2_147_483_647;

/**
 * A decimal integer from 1 to 2147483647, or the default when unset. Throws
 * (naming the variable) on anything else: malformed, zero, negative, a
 * fraction or exponent, or too large for the INTEGER columns.
 */
function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n) || n < 1 || n > PG_INT_MAX) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Pool size per trade for `scripts/seed-demo-tenants.ts` (default 3). */
export function demoPoolPerTrade(): number {
  return positiveInt('DEMO_POOL_PER_TRADE', process.env.DEMO_POOL_PER_TRADE, 3);
}

/** The module's numbers (plan U7 "Configuration and alerts"; integer cents). */
export interface DemoSettings {
  /** `DEMO_CALLS_DAILY_CAP`: calls reserved per UTC day (default 50). */
  callsDailyCap: number;
  /** `DEMO_COST_DAILY_CAP_CENTS`: estimated cents reserved per UTC day (default 2500). */
  costDailyCapCents: number;
  /**
   * `DEMO_CALL_EST_COST_CENTS`: the per-call estimate each reservation takes
   * (default 50, for the 90 s `TimeLimit`; the staging measurement replaces it).
   */
  callEstCostCents: number;
  /** `DEMO_POOL_PER_TRADE` (default 3). */
  poolPerTrade: number;
  /** `DEMO_STATUS_TOKEN_TTL_HOURS`: how long a status callback can still bind (default 24). */
  statusTokenTtlHours: number;
  /** `DEMO_RESET_BATCH_ROWS`: rows per delete batch in the reset walk (default 1000). */
  resetBatchRows: number;
  /** `DEMO_RESET_DRAIN_SECONDS`: how long the reset waits on in-flight jobs (default 90). */
  resetDrainSeconds: number;
}

/**
 * Open with frozen settings, or closed with the reason: a closed module
 * refuses every demo request (503 `DEMO_DISABLED`) while the rest of the app
 * boots normally.
 */
export type DemoConfig =
  | Readonly<{ open: true; settings: Readonly<DemoSettings> }>
  | Readonly<{ open: false; reason: string }>;

/**
 * Read the module's numbers once, at boot. A missing value takes its
 * default; a malformed, zero or negative one, or a per-call estimate above
 * the daily cost cap, closes the module with one error log instead of
 * guessing. These values are deliberately not on `shared/config.ts`'s zod
 * schema, whose failure aborts the whole process. The caps are written onto
 * a day's budget row when the row is created, so a changed value applies
 * from the next UTC day; the kill switch (`isDemoCallsEnabled`, read per
 * request) is the immediate lever and is not read here.
 */
export function loadDemoConfig(
  env: Record<string, string | undefined> = process.env,
  logger?: { error(msg: string, ctx?: Record<string, unknown>): void },
): DemoConfig {
  let settings: DemoSettings;
  try {
    settings = {
      callsDailyCap: positiveInt('DEMO_CALLS_DAILY_CAP', env.DEMO_CALLS_DAILY_CAP, 50),
      costDailyCapCents: positiveInt('DEMO_COST_DAILY_CAP_CENTS', env.DEMO_COST_DAILY_CAP_CENTS, 2500),
      callEstCostCents: positiveInt('DEMO_CALL_EST_COST_CENTS', env.DEMO_CALL_EST_COST_CENTS, 50),
      poolPerTrade: positiveInt('DEMO_POOL_PER_TRADE', env.DEMO_POOL_PER_TRADE, 3),
      statusTokenTtlHours: positiveInt('DEMO_STATUS_TOKEN_TTL_HOURS', env.DEMO_STATUS_TOKEN_TTL_HOURS, 24),
      resetBatchRows: positiveInt('DEMO_RESET_BATCH_ROWS', env.DEMO_RESET_BATCH_ROWS, 1000),
      resetDrainSeconds: positiveInt('DEMO_RESET_DRAIN_SECONDS', env.DEMO_RESET_DRAIN_SECONDS, 90),
    };
    if (settings.callEstCostCents > settings.costDailyCapCents) {
      throw new Error(
        `DEMO_CALL_EST_COST_CENTS (${settings.callEstCostCents}) is above DEMO_COST_DAILY_CAP_CENTS (${settings.costDailyCapCents})`,
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger?.error('demo call module closed: bad configuration', { reason });
    return Object.freeze({ open: false as const, reason });
  }
  return Object.freeze({ open: true as const, settings: Object.freeze(settings) });
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
