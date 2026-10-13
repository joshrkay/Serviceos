/**
 * Production can boot with NO path that pages a human: SENTRY_DSN and
 * ALERT_SMS_TO are both optional. That stays legal — prod runs without
 * SENTRY_DSN today, and failing boot would take it down — but it must be said
 * out loud: one config warning (logged WARN at boot by app.ts), never a throw.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfig } from '../../src/shared/config';

const PROD_ENV = {
  NODE_ENV: 'prod',
  DATABASE_URL: 'postgres://u:p@h/d',
  CLERK_SECRET_KEY: 'sk_x',
  CLERK_PUBLISHABLE_KEY: 'pk_x',
  CLERK_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_stripe_x',
  AI_PROVIDER_API_KEY: 'ak_x',
  CORS_ORIGIN: 'https://app.example.com',
  WEB_URL: 'https://app.example.com',
  PUBLIC_API_URL: 'https://api.example.com',
  TELEPHONY_ENABLED: 'false',
  EMAIL_ENABLED: 'false',
  STORAGE_ENABLED: 'false',
  RLS_RUNTIME_ROLE: 'true',
  TENANT_ENCRYPTION_KEY: 'a'.repeat(64),
};

const pagingWarnings = (warnings: string[]) =>
  warnings.filter((w) => w.includes('SENTRY_DSN') && w.includes('ALERT_SMS_TO'));

describe('config — no human-paging channel in production', () => {
  beforeEach(() => resetConfig());

  it('warns, without failing boot, when production has neither SENTRY_DSN nor ALERT_SMS_TO', () => {
    const config = loadConfig({ ...PROD_ENV });

    expect(pagingWarnings(config.warnings)).toHaveLength(1);
  });

  it('does not warn once SENTRY_DSN is set', () => {
    const config = loadConfig({ ...PROD_ENV, SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1' });

    expect(pagingWarnings(config.warnings)).toHaveLength(0);
  });

  it('does not warn once ALERT_SMS_TO is set', () => {
    const config = loadConfig({ ...PROD_ENV, ALERT_SMS_TO: '+15551230000' });

    expect(pagingWarnings(config.warnings)).toHaveLength(0);
  });

  it('does not warn outside prod/staging', () => {
    const config = loadConfig({ NODE_ENV: 'dev' });

    expect(pagingWarnings(config.warnings)).toHaveLength(0);
  });
});
