import { loadConfig, resetConfig, EnvironmentSecretResolver } from '../../src/shared/config';

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
      AI_PROVIDER_API_KEY: 'ak_test',
      AI_PROVIDER_BASE_URL: 'https://ai.example.com',
      LOG_LEVEL: 'debug',
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
});
