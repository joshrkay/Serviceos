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
  DB_NAME: z.string().default('serviceos_dev'),
  DB_USER: z.string().default('serviceos'),
  DB_PASSWORD: z.string().default(''),
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
  AI_PROVIDER_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_DEFAULT_MODEL: z.string().default('gpt-4o-mini'),
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WEBHOOK_SIGNING_SECRET: z.string().optional(),
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
  return cachedConfig;
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
