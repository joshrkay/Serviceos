import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z
    .enum(['dev', 'staging', 'prod', 'development', 'production', 'test'])
    .default('dev')
    .transform((v) => {
      if (v === 'development') return 'dev';
      if (v === 'production') return 'prod';
      return v as 'dev' | 'staging' | 'prod' | 'test';
    }),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().optional(),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  CLERK_JWKS_URL: z.string().url().optional(),
  // P0-033 — gate for the legacy HMAC-SHA256 dev path in `verifyClerkSession`.
  // Only honoured when explicitly set to the literal string 'true'. Refused
  // in production by `validateEnvSchema` so a misconfigured prod can't
  // silently fall back to HMAC.
  CLERK_DEV_HMAC_TOKENS: z.string().optional(),
  // Cloudflare R2 — S3-compatible object storage for file uploads
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('serviceos-uploads'),
  R2_PUBLIC_URL: z.string().url().optional(),
  AI_PROVIDER_API_KEY: z.string().min(1).optional(),
  AI_PROVIDER_BASE_URL: z.string().url().optional(),
  AI_DEFAULT_MODEL: z.string().default('gpt-4o-mini'),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WEBHOOK_SIGNING_SECRET: z.string().optional(),
  CORS_ORIGIN: z.string().optional(),
  STRIPE_API_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

let cachedConfig: AppConfig | null = null;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  if (cachedConfig) return cachedConfig;

  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  ${i.path.join('.')}: ${i.message}`
    );
    throw new Error(`Configuration validation failed:\n${issues.join('\n')}`);
  }

  cachedConfig = result.data;

  // Enforce required config in production environments
  if (cachedConfig.NODE_ENV === 'prod' || cachedConfig.NODE_ENV === 'staging') {
    validateProductionConfig(cachedConfig);
    validateFeatureRequiredConfig(env);
  }

  return cachedConfig;
}

/**
 * Validates that all required production configuration is present.
 * Throws on missing critical env vars that have no safe default.
 */
function validateProductionConfig(config: AppConfig): void {
  const missing: string[] = [];

  // Database — must have either DATABASE_URL or explicit host/name/user/password
  if (!config.DATABASE_URL) {
    if (!config.DB_HOST) missing.push('DB_HOST (or DATABASE_URL)');
    if (!config.DB_NAME) missing.push('DB_NAME (or DATABASE_URL)');
    if (!config.DB_USER) missing.push('DB_USER (or DATABASE_URL)');
    if (!config.DB_PASSWORD) missing.push('DB_PASSWORD (or DATABASE_URL)');
  }

  // Auth — both keys are required. The publishable key is used at request time
  // to derive the Clerk JWKS host; without it every authenticated request 401s
  // (P0-033). Fail fast at startup instead of waiting for the first request.
  if (!config.CLERK_SECRET_KEY) missing.push('CLERK_SECRET_KEY');
  if (!config.CLERK_PUBLISHABLE_KEY) missing.push('CLERK_PUBLISHABLE_KEY');

  // Webhooks — signing secrets required to verify inbound webhooks
  if (!config.CLERK_WEBHOOK_SECRET) missing.push('CLERK_WEBHOOK_SECRET');

  // AI provider
  if (!config.AI_PROVIDER_API_KEY) missing.push('AI_PROVIDER_API_KEY');

  // CORS — must be an explicit origin, not the wildcard fallback
  if (!config.CORS_ORIGIN) missing.push('CORS_ORIGIN');

  // NOTE (P5-017): Stripe payment-link key (STRIPE_SECRET_KEY / STRIPE_API_KEY)
  // is enforced at boot by `createPaymentLinkProvider` in
  // `payments/payment-link-provider.ts` rather than here, because the
  // existing AC#1 test surface in `config.test.ts` is fixed and the
  // payment-link factory provides an equivalent fail-fast guard.

  if (missing.length > 0) {
    throw new Error(
      `Production configuration is missing required values:\n  ${missing.join('\n  ')}\n` +
        'Set these environment variables before starting in production.'
    );
  }
}

/**
 * P7-023 follow-up — feature-required config gate.
 *
 * Today the app reads TWILIO_* / SENDGRID_* / R2_* directly from
 * process.env in `app.ts` and conditionally wires the providers when
 * present. Missing vars previously caused silent feature degradation
 * (SMS no-ops, recordings drop, invoice email never sends) with no
 * boot signal. This gate flips that to fail-loud-by-default in
 * production / staging: each feature bundle is required unless the
 * operator has explicitly opted out via a `<FEATURE>_ENABLED=false`
 * flag. The error message names every missing var so an operator can
 * fix it directly.
 */
function validateFeatureRequiredConfig(env: Record<string, string | undefined>): void {
  const missing: string[] = [];

  // Telephony — Twilio voice + SMS. Default tenant id is required when
  // telephony is on so inbound calls resolve to a tenant before the
  // multi-tenant phone-lookup ships (B1 in the launch readiness plan).
  if (env.TELEPHONY_ENABLED !== 'false') {
    if (!env.TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID (or set TELEPHONY_ENABLED=false)');
    if (!env.TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN (or set TELEPHONY_ENABLED=false)');
    if (!env.TWILIO_FROM_NUMBER) missing.push('TWILIO_FROM_NUMBER (or set TELEPHONY_ENABLED=false)');
    if (!env.TWILIO_DEFAULT_TENANT_ID) {
      missing.push('TWILIO_DEFAULT_TENANT_ID (or set TELEPHONY_ENABLED=false)');
    }
  }

  // Email delivery — invoice + estimate notifications via SendGrid.
  if (env.EMAIL_ENABLED !== 'false') {
    if (!env.SENDGRID_API_KEY) missing.push('SENDGRID_API_KEY (or set EMAIL_ENABLED=false)');
    if (!env.SENDGRID_FROM_EMAIL) missing.push('SENDGRID_FROM_EMAIL (or set EMAIL_ENABLED=false)');
  }

  // Object storage — voice recordings, file/job uploads via Cloudflare R2.
  if (env.STORAGE_ENABLED !== 'false') {
    if (!env.R2_ACCOUNT_ID) missing.push('R2_ACCOUNT_ID (or set STORAGE_ENABLED=false)');
    if (!env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID (or set STORAGE_ENABLED=false)');
    if (!env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY (or set STORAGE_ENABLED=false)');
    if (!env.R2_PUBLIC_URL) missing.push('R2_PUBLIC_URL (or set STORAGE_ENABLED=false)');
  }

  if (missing.length > 0) {
    throw new Error(
      `Production feature configuration is missing required values:\n  ${missing.join('\n  ')}\n` +
        'Set these env vars before starting, or opt the feature out with the named flag.'
    );
  }
}

export function resetConfig(): void {
  cachedConfig = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// P0-026 — Startup environment validation (Zod schema)
//
// `validateEnvSchema(env)` is a sibling to `loadConfig`/`validateProductionConfig`
// that returns a strongly typed, parsed `Env` object. It is the canonical entry
// point for fail-fast startup validation; existing call sites of `loadConfig`
// keep their current contract (we don't want to break `app.ts`).
//
// Required vars:           DATABASE_URL, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY,
//                          CORS_ORIGIN (not the literal 'true' in production),
//                          NODE_ENV
// Optional with defaults:  PORT (8080), LOG_LEVEL (info)
//
// In `NODE_ENV=development` (or `dev`/`test`) the Clerk and DATABASE_URL keys
// become optional so that local boot does not require production secrets.
// ─────────────────────────────────────────────────────────────────────────────

const envEnum = z.enum(['development', 'dev', 'test', 'staging', 'production', 'prod']);

const baseEnvShape = {
  NODE_ENV: envEnum.default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGIN: z.string().min(1).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  // P0-033 — legacy HMAC dev-token gate. Production refuses any value other
  // than absent/'false' (enforced via the prod refinement on the schema).
  CLERK_DEV_HMAC_TOKENS: z.string().optional(),
} as const;

const devEnvSchema = z.object({
  ...baseEnvShape,
  // In dev, DATABASE_URL may be absent (in-memory repos) but if provided
  // it still must be a valid URL.
  DATABASE_URL: z
    .string()
    .url({ message: 'must be a valid URL (e.g. postgres://user:pass@host/db)' })
    .optional(),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
});

const prodEnvSchema = z
  .object({
    ...baseEnvShape,
    DATABASE_URL: z
      .string({ required_error: 'Required' })
      .url({ message: 'must be a valid URL (e.g. postgres://user:pass@host/db)' }),
    CLERK_SECRET_KEY: z
      .string({ required_error: 'Required' })
      .min(1, { message: 'Required' }),
    CLERK_PUBLISHABLE_KEY: z
      .string({ required_error: 'Required' })
      .min(1, { message: 'Required' }),
    CORS_ORIGIN: z
      .string({ required_error: 'Required' })
      .min(1, { message: 'Required' })
      .refine((v) => v !== 'true', {
        message: "Cannot be 'true' in production. Set a specific origin.",
      }),
    // P0-033 — must NOT be 'true' in production. Other values (absent,
    // 'false', '0', anything else) are accepted as "off". The runtime gate
    // in `verifyClerkSession` is also production-disabled as defense in
    // depth, but failing fast at startup gives operators a clear signal.
    CLERK_DEV_HMAC_TOKENS: z
      .string()
      .optional()
      .refine((v) => v !== 'true', {
        message:
          "CLERK_DEV_HMAC_TOKENS=true is forbidden in production. Unset or set to 'false' before starting.",
      }),
  });

export type Env = z.infer<typeof devEnvSchema> & Partial<z.infer<typeof prodEnvSchema>>;

function isProductionEnv(value: string | undefined): boolean {
  return value === 'production' || value === 'prod';
}

/**
 * Parses and validates `process.env` against the runtime environment schema.
 *
 * @returns A frozen, typed `Env` object. Pure parse — calling twice with the
 *   same input yields equivalent objects (idempotent, no caching).
 * @throws Error with one line per missing/invalid var when validation fails.
 *   Each line names the variable so an operator can fix it directly.
 */
export function validateEnvSchema(
  env: Record<string, string | undefined> = process.env
): Env {
  const schema = isProductionEnv(env.NODE_ENV) ? prodEnvSchema : devEnvSchema;
  const result = schema.safeParse(env);

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)';
      return `  - ${name}: ${issue.message}`;
    });
    throw new Error(
      `Environment validation failed:\n${lines.join('\n')}\n` +
        'Set these environment variables before starting the service.'
    );
  }

  return result.data as Env;
}

export interface SecretResolver {
  resolve(secretName: string): Promise<string>;
}

export class EnvironmentSecretResolver implements SecretResolver {
  async resolve(secretName: string): Promise<string> {
    const value = process.env[secretName];
    if (!value) {
      throw new Error(`Secret not found: ${secretName}`);
    }
    return value;
  }
}

// P0-006 — Secrets backend decision.
//
// The PRD suggested AWS Secrets Manager, but the project deploys on Railway,
// which natively encrypts environment variables at rest and supports rotation
// via the Railway dashboard. Swapping to AWS SM would add a second control
// plane without reducing risk, so EnvironmentSecretResolver is the canonical
// resolver in every environment.
//
// loadConfig() enforces that all required production secrets are set before
// the app boots (AC#1), and the logger redacts any secret-keyed values before
// emitting structured JSON (AC#2 — see logging/redact.ts).
export function createSecretResolver(_env: string): SecretResolver {
  return new EnvironmentSecretResolver();
}
