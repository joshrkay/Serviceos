import {
  loadConfig,
  resetConfig,
  EnvironmentSecretResolver,
  validateEnvSchema,
} from '../../src/shared/config';

describe('P0-006 — Secrets/config framework', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('happy path — loads config with defaults', () => {
    const config = loadConfig({ NODE_ENV: 'dev' });
    expect(config.NODE_ENV).toBe('dev');
    expect(config.PORT).toBe(3000);
    expect(config.DB_HOST).toBe('localhost');
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('happy path — loads config with custom values', () => {
    const config = loadConfig({
      NODE_ENV: 'staging',
      PORT: '8080',
      DB_HOST: 'db.example.com',
      DB_PORT: '5433',
      DB_NAME: 'serviceos',
      DB_USER: 'admin',
      DB_PASSWORD: 'secret',
      CLERK_SECRET_KEY: 'sk_test_staging',
      CLERK_PUBLISHABLE_KEY: 'pk_test_staging',
      CLERK_WEBHOOK_SECRET: 'whsec_test',
      AI_PROVIDER_API_KEY: 'ak_test',
      AI_PROVIDER_BASE_URL: 'https://ai.example.com',
      CORS_ORIGIN: 'https://app.example.com',
      LOG_LEVEL: 'debug',
      // Opt features out so the feature-required gate doesn't fire;
      // its own behavior is covered by the dedicated tests below.
      TELEPHONY_ENABLED: 'false',
      EMAIL_ENABLED: 'false',
      STORAGE_ENABLED: 'false',
    });
    expect(config.NODE_ENV).toBe('staging');
    expect(config.PORT).toBe(8080);
    expect(config.DB_HOST).toBe('db.example.com');
    expect(config.DB_PORT).toBe(5433);
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('validation — rejects invalid NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'invalid' })).toThrow('Configuration validation failed');
  });

  it('validation — rejects invalid PORT', () => {
    expect(() => loadConfig({ NODE_ENV: 'dev', PORT: '-1' })).toThrow(
      'Configuration validation failed'
    );
  });

  it('validation — rejects invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ NODE_ENV: 'dev', LOG_LEVEL: 'trace' })).toThrow(
      'Configuration validation failed'
    );
  });

  it('happy path — config is cached after first load', () => {
    const c1 = loadConfig({ NODE_ENV: 'dev' });
    const c2 = loadConfig({ NODE_ENV: 'prod' });
    expect(c1).toBe(c2);
  });

  it('happy path — EnvironmentSecretResolver resolves env vars', async () => {
    process.env.TEST_SECRET = 'my-secret-value';
    const resolver = new EnvironmentSecretResolver();
    const value = await resolver.resolve('TEST_SECRET');
    expect(value).toBe('my-secret-value');
    delete process.env.TEST_SECRET;
  });

  it('validation — EnvironmentSecretResolver throws on missing secret', async () => {
    const resolver = new EnvironmentSecretResolver();
    await expect(resolver.resolve('NONEXISTENT_SECRET')).rejects.toThrow('Secret not found');
  });

  it('AC#1 — production load fails when CLERK_SECRET_KEY is missing', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'prod',
        DATABASE_URL: 'postgres://u:p@h/d',
        CLERK_WEBHOOK_SECRET: 'whsec_x',
        AI_PROVIDER_API_KEY: 'ak_x',
        CORS_ORIGIN: 'https://app.example.com',
      })
    ).toThrow(/CLERK_SECRET_KEY/);
  });

  it('AC#1 — production load fails when CORS_ORIGIN is missing', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'prod',
        DATABASE_URL: 'postgres://u:p@h/d',
        CLERK_SECRET_KEY: 'sk_x',
        CLERK_WEBHOOK_SECRET: 'whsec_x',
        AI_PROVIDER_API_KEY: 'ak_x',
      })
    ).toThrow(/CORS_ORIGIN/);
  });

  it('AC#1 — production load fails when DB credentials are missing', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'prod',
        CLERK_SECRET_KEY: 'sk_x',
        CLERK_WEBHOOK_SECRET: 'whsec_x',
        AI_PROVIDER_API_KEY: 'ak_x',
        CORS_ORIGIN: 'https://app.example.com',
      })
    ).toThrow(/DB_NAME|DB_USER|DB_PASSWORD/);
  });

  it('AC#1 — production load succeeds when all required secrets present', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'prod',
        DATABASE_URL: 'postgres://u:p@h/d',
        CLERK_SECRET_KEY: 'sk_x',
        CLERK_PUBLISHABLE_KEY: 'pk_x',
        CLERK_WEBHOOK_SECRET: 'whsec_x',
        AI_PROVIDER_API_KEY: 'ak_x',
        CORS_ORIGIN: 'https://app.example.com',
        // Opt features out so the feature-required gate doesn't fire.
        // The feature-required gate has its own dedicated tests below.
        TELEPHONY_ENABLED: 'false',
        EMAIL_ENABLED: 'false',
        STORAGE_ENABLED: 'false',
      })
    ).not.toThrow();
  });

  it('AC#1 — production load fails when CLERK_PUBLISHABLE_KEY is missing', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'prod',
        DATABASE_URL: 'postgres://u:p@h/d',
        CLERK_SECRET_KEY: 'sk_x',
        CLERK_WEBHOOK_SECRET: 'whsec_x',
        AI_PROVIDER_API_KEY: 'ak_x',
        CORS_ORIGIN: 'https://app.example.com',
      })
    ).toThrow(/CLERK_PUBLISHABLE_KEY/);
  });

  describe('feature-required config gate (Sprint 1 / Story 1.5)', () => {
    const baseProdEnv = {
      NODE_ENV: 'prod',
      DATABASE_URL: 'postgres://u:p@h/d',
      CLERK_SECRET_KEY: 'sk_x',
      CLERK_PUBLISHABLE_KEY: 'pk_x',
      CLERK_WEBHOOK_SECRET: 'whsec_x',
      AI_PROVIDER_API_KEY: 'ak_x',
      CORS_ORIGIN: 'https://app.example.com',
    };

    it('telephony — fails naming each missing TWILIO var when not opted out', () => {
      expect(() =>
        loadConfig({
          ...baseProdEnv,
          EMAIL_ENABLED: 'false',
          STORAGE_ENABLED: 'false',
        })
      ).toThrow(/TWILIO_ACCOUNT_SID[\s\S]*TWILIO_AUTH_TOKEN[\s\S]*TWILIO_FROM_NUMBER[\s\S]*TWILIO_DEFAULT_TENANT_ID/);
    });

    it('telephony — passes when TELEPHONY_ENABLED=false even with no Twilio vars', () => {
      expect(() =>
        loadConfig({
          ...baseProdEnv,
          TELEPHONY_ENABLED: 'false',
          EMAIL_ENABLED: 'false',
          STORAGE_ENABLED: 'false',
        })
      ).not.toThrow();
    });

    it('email — fails when SENDGRID_API_KEY missing and EMAIL_ENABLED not set to false', () => {
      expect(() =>
        loadConfig({
          ...baseProdEnv,
          TELEPHONY_ENABLED: 'false',
          STORAGE_ENABLED: 'false',
        })
      ).toThrow(/SENDGRID_API_KEY/);
    });

    it('storage — fails when R2 vars missing and STORAGE_ENABLED not set to false', () => {
      expect(() =>
        loadConfig({
          ...baseProdEnv,
          TELEPHONY_ENABLED: 'false',
          EMAIL_ENABLED: 'false',
        })
      ).toThrow(/R2_ACCOUNT_ID[\s\S]*R2_ACCESS_KEY_ID[\s\S]*R2_SECRET_ACCESS_KEY[\s\S]*R2_PUBLIC_URL/);
    });

    it('passes when all feature vars are set', () => {
      expect(() =>
        loadConfig({
          ...baseProdEnv,
          TWILIO_ACCOUNT_SID: 'AC_x',
          TWILIO_AUTH_TOKEN: 't_x',
          TWILIO_FROM_NUMBER: '+15551234567',
          TWILIO_DEFAULT_TENANT_ID: 'tenant-1',
          SENDGRID_API_KEY: 'SG.x',
          SENDGRID_FROM_EMAIL: 'noreply@example.com',
          R2_ACCOUNT_ID: 'r2acct',
          R2_ACCESS_KEY_ID: 'r2key',
          R2_SECRET_ACCESS_KEY: 'r2secret',
          R2_PUBLIC_URL: 'https://cdn.example.com',
        })
      ).not.toThrow();
    });

    it('dev environment skips the feature gate entirely', () => {
      // Dev should never trip these — silent feature-off is the
      // intended local behavior.
      expect(() => loadConfig({ NODE_ENV: 'dev' })).not.toThrow();
    });
  });
});

describe('P0-026 — validateEnvSchema (Zod startup validation)', () => {
  const fullProdEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@h:5432/d',
    CLERK_SECRET_KEY: 'sk_live_abc',
    CLERK_PUBLISHABLE_KEY: 'pk_live_abc',
    CORS_ORIGIN: 'https://app.example.com',
  };

  it('happy path — all vars present, returns typed Env object', () => {
    const env = validateEnvSchema(fullProdEnv);
    expect(env.NODE_ENV).toBe('production');
    expect(env.DATABASE_URL).toBe('postgres://u:p@h:5432/d');
    expect(env.CLERK_SECRET_KEY).toBe('sk_live_abc');
    expect(env.CLERK_PUBLISHABLE_KEY).toBe('pk_live_abc');
    expect(env.CORS_ORIGIN).toBe('https://app.example.com');
    // Defaults applied:
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('happy path — applies PORT and LOG_LEVEL defaults when omitted', () => {
    const env = validateEnvSchema({ NODE_ENV: 'development' });
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('validateEnvSchema — missing CLERK_SECRET_KEY in production throws naming the var', () => {
    const env = { ...fullProdEnv } as Record<string, string | undefined>;
    delete env.CLERK_SECRET_KEY;
    expect(() => validateEnvSchema(env)).toThrow(/CLERK_SECRET_KEY/);
  });

  it('validateEnvSchema — missing DATABASE_URL in production throws naming the var', () => {
    const env = { ...fullProdEnv } as Record<string, string | undefined>;
    delete env.DATABASE_URL;
    expect(() => validateEnvSchema(env)).toThrow(/DATABASE_URL/);
  });

  it('validateEnvSchema — missing CLERK_PUBLISHABLE_KEY in production throws naming the var', () => {
    const env = { ...fullProdEnv } as Record<string, string | undefined>;
    delete env.CLERK_PUBLISHABLE_KEY;
    expect(() => validateEnvSchema(env)).toThrow(/CLERK_PUBLISHABLE_KEY/);
  });

  it("validateEnvSchema — CORS_ORIGIN='true' in production throws with clear error", () => {
    const env = { ...fullProdEnv, CORS_ORIGIN: 'true' };
    expect(() => validateEnvSchema(env)).toThrow(
      /CORS_ORIGIN.*Cannot be 'true' in production/
    );
  });

  it('validateEnvSchema — development mode allows missing Clerk and DATABASE_URL', () => {
    expect(() => validateEnvSchema({ NODE_ENV: 'development' })).not.toThrow();
    const env = validateEnvSchema({ NODE_ENV: 'development' });
    expect(env.NODE_ENV).toBe('development');
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('validateEnvSchema — invalid DATABASE_URL format throws clear error', () => {
    const env = { ...fullProdEnv, DATABASE_URL: 'not-a-url' };
    expect(() => validateEnvSchema(env)).toThrow(/DATABASE_URL/);
  });

  it('validateEnvSchema — error message lists every missing var on its own line', () => {
    let thrown: Error | undefined;
    try {
      validateEnvSchema({ NODE_ENV: 'production' });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    const msg = thrown!.message;
    expect(msg).toMatch(/Environment validation failed/);
    expect(msg).toMatch(/DATABASE_URL/);
    expect(msg).toMatch(/CLERK_SECRET_KEY/);
    expect(msg).toMatch(/CLERK_PUBLISHABLE_KEY/);
    expect(msg).toMatch(/CORS_ORIGIN/);
    // Each missing var on its own line, prefixed with the var name.
    expect(msg.split('\n').filter((l) => l.startsWith('  - ')).length).toBeGreaterThanOrEqual(4);
  });

  it('validateEnvSchema — returns equivalent typed object on a 2nd call (idempotent)', () => {
    const a = validateEnvSchema(fullProdEnv);
    const b = validateEnvSchema(fullProdEnv);
    expect(a).toEqual(b);
    // No caching: the function returns a fresh object each time
    expect(a).not.toBe(b);
  });

  it('validateEnvSchema — coerces PORT from string', () => {
    const env = validateEnvSchema({ ...fullProdEnv, PORT: '9090' });
    expect(env.PORT).toBe(9090);
  });

  it('validateEnvSchema — rejects invalid LOG_LEVEL', () => {
    expect(() =>
      validateEnvSchema({ ...fullProdEnv, LOG_LEVEL: 'trace' })
    ).toThrow(/LOG_LEVEL/);
  });

  it("validateEnvSchema — CORS_ORIGIN='true' is allowed in development (relaxed)", () => {
    expect(() =>
      validateEnvSchema({ NODE_ENV: 'development', CORS_ORIGIN: 'true' })
    ).not.toThrow();
  });
});
