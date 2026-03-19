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
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().optional(),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  CLERK_JWKS_URL: z.string().url().optional(),
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

  // Auth
  if (!config.CLERK_SECRET_KEY) missing.push('CLERK_SECRET_KEY');

  // AI provider
  if (!config.AI_PROVIDER_API_KEY) missing.push('AI_PROVIDER_API_KEY');
  if (!config.AI_PROVIDER_BASE_URL) missing.push('AI_PROVIDER_BASE_URL');

  if (missing.length > 0) {
    throw new Error(
      `Production configuration is missing required values:\n  ${missing.join('\n  ')}\n` +
        'Set these environment variables before starting in production.'
    );
  }
}

export function resetConfig(): void {
  cachedConfig = null;
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

// Secrets are managed as Railway environment variables in all environments.
// Use the Railway dashboard to set and rotate secrets — no external secrets
// manager required.
export function createSecretResolver(_env: string): SecretResolver {
  return new EnvironmentSecretResolver();
}
