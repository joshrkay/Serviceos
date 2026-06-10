import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().int().default(3001),
  /** Non-superuser, RLS-enforced connection for all tenant-scoped work. */
  databaseUrl: z.string().min(1),
  /** Privileged connection: migrations, pg-boss, webhook ledger, outbox drain. */
  databaseAdminUrl: z.string().min(1),
  /** When unset, dev auth bypass (x-dev-user-id header) is active. */
  clerkJwksUrl: z.string().url().optional(),
  openaiApiKey: z.string().optional(),
  openaiBaseUrl: z.string().url().default('https://api.openai.com/v1'),
  stripeWebhookSecret: z.string().optional(),
  twilioAccountSid: z.string().optional(),
  twilioAuthToken: z.string().optional(),
  voiceWebhookSecret: z.string().optional(),
  /** Seconds between approval and execution during which undo is allowed. */
  undoWindowSeconds: z.coerce.number().int().min(0).default(5),
  webDistPath: z.string().optional(),
  env: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return configSchema.parse({
    port: process.env.PORT,
    databaseUrl: process.env.DATABASE_URL,
    databaseAdminUrl: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL,
    clerkJwksUrl: process.env.CLERK_JWKS_URL || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
    openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || undefined,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || undefined,
    voiceWebhookSecret: process.env.VOICE_WEBHOOK_SECRET || undefined,
    undoWindowSeconds: process.env.UNDO_WINDOW_SECONDS,
    webDistPath: process.env.WEB_DIST_PATH || undefined,
    env: (process.env.NODE_ENV as Config['env']) || undefined,
    ...JSON.parse(JSON.stringify(overrides)),
  });
}
