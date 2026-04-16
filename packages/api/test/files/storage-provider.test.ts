import { describe, it, expect } from 'vitest';
import {
  S3StorageProvider,
  DevStorageProvider,
  createStorageProvider,
} from '../../src/files/storage-provider';

describe('S3StorageProvider', () => {
  const provider = new S3StorageProvider({
    bucket: 'serviceos',
    region: 'auto',
    endpoint: 'https://abcdef.r2.cloudflarestorage.com',
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret-test-key',
  });

  it('generates a PUT url with SigV4 query params', async () => {
    const url = await provider.generateUploadUrl(
      'serviceos',
      'tenant-1/file-1/voice.webm',
      'audio/webm'
    );
    const parsed = new URL(url);
    expect(parsed.host).toBe('abcdef.r2.cloudflarestorage.com');
    expect(parsed.pathname).toBe('/serviceos/tenant-1/file-1/voice.webm');
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('AKIATEST');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('percent-encodes path segments without touching slashes', async () => {
    const url = await provider.generateUploadUrl(
      'serviceos',
      'tenant-1/file-1/name with spaces.webm',
      'audio/webm'
    );
    expect(url).toContain('/tenant-1/file-1/name%20with%20spaces.webm');
  });

  it('generateDownloadUrl uses publicUrlBase when set', async () => {
    const publicProvider = new S3StorageProvider({
      bucket: 'serviceos',
      region: 'auto',
      endpoint: 'https://abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret-test-key',
      publicUrlBase: 'https://cdn.example.com',
    });
    const url = await publicProvider.generateDownloadUrl('serviceos', 'a/b/c.webm');
    expect(url).toBe('https://cdn.example.com/a/b/c.webm');
  });
});

describe('DevStorageProvider', () => {
  it('returns a URL under the configured public base', async () => {
    const provider = new DevStorageProvider({
      bucket: 'serviceos-dev',
      publicUrlBase: '/storage-dev',
    });
    const url = await provider.generateUploadUrl(
      'serviceos-dev',
      'tenant-1/file-1/voice.webm',
      'audio/webm'
    );
    expect(url).toBe('/storage-dev/tenant-1/file-1/voice.webm');
  });
});

describe('createStorageProvider factory', () => {
  it('returns an S3 provider when full config is present', () => {
    const { provider, mode } = createStorageProvider({
      STORAGE_BUCKET: 'b',
      STORAGE_ENDPOINT: 'https://x.example.com',
      STORAGE_REGION: 'auto',
      STORAGE_ACCESS_KEY_ID: 'k',
      STORAGE_SECRET_ACCESS_KEY: 's',
      NODE_ENV: 'development',
    });
    expect(mode).toBe('s3');
    expect(provider).toBeInstanceOf(S3StorageProvider);
  });

  it('falls back to a dev provider in development when config is missing', () => {
    const { provider, mode } = createStorageProvider({ NODE_ENV: 'development' });
    expect(mode).toBe('dev');
    expect(provider).toBeInstanceOf(DevStorageProvider);
  });

  it('throws in production when config is missing', () => {
    expect(() => createStorageProvider({ NODE_ENV: 'prod' })).toThrow(/Storage configuration/);
    expect(() => createStorageProvider({ NODE_ENV: 'staging' })).toThrow(/Storage configuration/);
  });
});
