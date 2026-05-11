import { describe, it, expect } from 'vitest';
import {
  S3StorageProvider,
  DevStorageProvider,
  createStorageProvider,
  signS3Request,
} from '../../src/files/storage-provider';

describe('signS3Request (pure SigV4)', () => {
  it('matches the AWS SigV4 reference test vector', () => {
    const url = signS3Request({
      method: 'GET',
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      key: 'test.txt',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresSeconds: 86400,
      now: new Date('2013-05-24T00:00:00.000Z'),
      pathStyle: false,
    });
    const parsed = new URL(url);
    expect(parsed.host).toBe('examplebucket.s3.amazonaws.com');
    expect(parsed.pathname).toBe('/test.txt');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    );
  });

  it('binds content-type into the PUT signature when supplied', () => {
    const url = signS3Request({
      method: 'PUT',
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      key: 'a.webm',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresSeconds: 300,
      now: new Date('2013-05-24T00:00:00.000Z'),
      pathStyle: false,
      contentType: 'audio/webm',
    });
    const signedHeaders = new URL(url).searchParams.get('X-Amz-SignedHeaders');
    expect(signedHeaders).toBe('content-type;host');

    const withoutCt = signS3Request({
      method: 'PUT',
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      key: 'a.webm',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresSeconds: 300,
      now: new Date('2013-05-24T00:00:00.000Z'),
      pathStyle: false,
    });
    expect(new URL(withoutCt).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(new URL(url).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(withoutCt).searchParams.get('X-Amz-Signature')
    );
  });

  it('constructs virtual-hosted host from a regional endpoint', () => {
    const url = signS3Request({
      method: 'GET',
      endpoint: 'https://s3.us-west-2.amazonaws.com',
      region: 'us-west-2',
      bucket: 'my-bucket',
      key: 'foo.txt',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      expiresSeconds: 300,
      now: new Date('2026-04-01T00:00:00.000Z'),
      pathStyle: false,
    });
    expect(new URL(url).host).toBe('my-bucket.s3.us-west-2.amazonaws.com');
    expect(new URL(url).pathname).toBe('/foo.txt');
  });

  it('uses path-style host + /bucket/key when pathStyle=true', () => {
    const url = signS3Request({
      method: 'GET',
      endpoint: 'https://abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'serviceos',
      key: 'tenant-1/x.webm',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret',
      expiresSeconds: 300,
      now: new Date('2026-04-01T00:00:00.000Z'),
      pathStyle: true,
    });
    expect(new URL(url).host).toBe('abcdef.r2.cloudflarestorage.com');
    expect(new URL(url).pathname).toBe('/serviceos/tenant-1/x.webm');
  });
});

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
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
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
      publicUrlBase: 'http://localhost:3000/storage-dev',
    });
    const url = await provider.generateUploadUrl(
      'serviceos-dev',
      'tenant-1/file-1/voice.webm',
      'audio/webm'
    );
    expect(url).toBe('http://localhost:3000/storage-dev/tenant-1/file-1/voice.webm');
  });

  it('getObjectMetadata returns null (metadata not available)', async () => {
    const provider = new DevStorageProvider({
      bucket: 'serviceos-dev',
      publicUrlBase: 'http://localhost:3000/storage-dev',
    });
    expect(await provider.getObjectMetadata('serviceos-dev', 'tenant-1/file-1/voice.webm')).toBeNull();
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

  it('throws when storage config is missing in production-like envs', () => {
    expect(() => createStorageProvider({ NODE_ENV: 'prod' })).toThrow(/Storage configuration/);
    expect(() => createStorageProvider({ NODE_ENV: 'production' })).toThrow(/Storage configuration/);
    expect(() => createStorageProvider({ NODE_ENV: 'staging' })).toThrow(/Storage configuration/);
  });

  it('defaults dev public URL to an absolute localhost address', async () => {
    const { provider } = createStorageProvider({ NODE_ENV: 'development', API_PORT: '4321' });
    const url = await provider.generateUploadUrl('b', 'k', 'audio/webm');
    expect(url.startsWith('http://localhost:4321/storage-dev/')).toBe(true);
  });
});
