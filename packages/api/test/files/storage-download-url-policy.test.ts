/**
 * H2 review M1 — the storage download-URL policy never refuses an
 * operator-configured storage origin (that would silently fail every
 * transcription). An insecure-looking configured origin in a prod-like env
 * is surfaced ONCE at boot instead, and boot still succeeds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageProvider } from '../../src/files/storage-provider';

function s3(endpoint: string, nodeEnv: string, extra: Record<string, string> = {}) {
  return {
    NODE_ENV: nodeEnv,
    STORAGE_BUCKET: 'b',
    STORAGE_ENDPOINT: endpoint,
    STORAGE_REGION: 'auto',
    STORAGE_ACCESS_KEY_ID: 'k',
    STORAGE_SECRET_ACCESS_KEY: 's',
    ...extra,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('H2 review M1 — boot-time warning for an insecure configured storage origin', () => {
  it.each([
    ['an http endpoint in prod', s3('http://bucket.railway.internal:9000', 'prod'), 'http://bucket.railway.internal:9000'],
    ['an IP-literal endpoint in production', s3('https://10.0.0.5', 'production'), 'https://10.0.0.5'],
    [
      'an http STORAGE_PUBLIC_URL in staging',
      s3('https://acct123.r2.cloudflarestorage.com', 'staging', { STORAGE_PUBLIC_URL: 'http://cdn.example.com/media' }),
      'http://cdn.example.com',
    ],
  ])('warns exactly once, and still boots, for %s', (_label, env, origin) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const storage = createStorageProvider(env);

    expect(storage.mode).toBe('s3');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain(origin);
  });

  it.each([
    ['https R2 endpoint in production', s3('https://acct123.r2.cloudflarestorage.com', 'production')],
    ['http MinIO in development', s3('http://localhost:9000', 'development')],
    ['dev storage in test', { NODE_ENV: 'test' }],
  ])('stays quiet for %s', (_label, env) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    createStorageProvider(env);

    expect(warn).not.toHaveBeenCalled();
  });
});
