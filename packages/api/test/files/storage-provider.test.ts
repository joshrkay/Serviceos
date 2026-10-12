import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'crypto';
import {
  S3StorageProvider,
  DevStorageProvider,
  createStorageProvider,
  signS3Request,
  signDevStorageToken,
  verifyDevStorageToken,
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

// Independent re-implementation of what S3/R2 do when a presigned PUT
// arrives: rebuild the canonical request from the URL's query and the
// headers the client ACTUALLY sent (restricted to X-Amz-SignedHeaders), and
// compare signatures. Written separately from signS3Request so the test
// exercises the wire contract, not the implementation against itself.
function storageAcceptsPut(
  presignedUrl: string,
  sentHeaders: Record<string, string>,
  secretAccessKey: string
): boolean {
  const url = new URL(presignedUrl);
  const q = url.searchParams;
  const providedSignature = q.get('X-Amz-Signature');
  const signedHeaderNames = (q.get('X-Amz-SignedHeaders') ?? '').split(';');
  const lower: Record<string, string> = { host: url.host };
  for (const [k, v] of Object.entries(sentHeaders)) lower[k.toLowerCase()] = v;
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${lower[h] ?? ''}\n`).join('');
  const enc = (v: string) =>
    encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const canonicalQuery = [...q.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&');
  const canonicalRequest = [
    'PUT',
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const [, dateStamp, region, service] = (q.get('X-Amz-Credential') ?? '').split('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    q.get('X-Amz-Date'),
    `${dateStamp}/${region}/${service}/aws4_request`,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const h = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
  const kSigning = h(h(h(h(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const expected = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return expected === providedSignature;
}

describe('presigned PUT binds the declared size as Content-Length', () => {
  const SECRET = 'secret-test-key';
  const provider = new S3StorageProvider({
    bucket: 'serviceos',
    region: 'auto',
    endpoint: 'https://abcdef.r2.cloudflarestorage.com',
    accessKeyId: 'AKIATEST',
    secretAccessKey: SECRET,
  });

  it('signs content-length (sorted before content-type and host) on upload URLs', async () => {
    const url = await provider.generateUploadUrl('serviceos', 'tenant-1/f/photo.jpg', 'image/jpeg', 2048);
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host'
    );
  });

  it('is accepted only when the PUT Content-Length equals the declared sizeBytes', async () => {
    const declared = 100;
    const url = await provider.generateUploadUrl('serviceos', 'tenant-1/f/photo.jpg', 'image/jpeg', declared);
    // Legitimate upload: browser sends Content-Length = blob.size = declared.
    expect(
      storageAcceptsPut(url, { 'Content-Type': 'image/jpeg', 'Content-Length': String(declared) }, SECRET)
    ).toBe(true);
    // The audited attack: declare 100 bytes, PUT 5 GB.
    expect(
      storageAcceptsPut(url, { 'Content-Type': 'image/jpeg', 'Content-Length': String(5 * 1024 ** 3) }, SECRET)
    ).toBe(false);
    // Off-by-one in either direction is rejected too.
    expect(storageAcceptsPut(url, { 'Content-Type': 'image/jpeg', 'Content-Length': '101' }, SECRET)).toBe(false);
    expect(storageAcceptsPut(url, { 'Content-Type': 'image/jpeg', 'Content-Length': '99' }, SECRET)).toBe(false);
    // Content-Type binding still holds alongside it.
    expect(storageAcceptsPut(url, { 'Content-Type': 'text/html', 'Content-Length': '100' }, SECRET)).toBe(false);
  });

  it('different declared sizes produce different signatures', async () => {
    const a = await provider.generateUploadUrl('serviceos', 'k.jpg', 'image/jpeg', 100);
    const b = await provider.generateUploadUrl('serviceos', 'k.jpg', 'image/jpeg', 101);
    expect(new URL(a).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(b).searchParams.get('X-Amz-Signature')
    );
  });

  it('refuses to mint an upload URL without a valid integer size', async () => {
    for (const bad of [NaN, -1, 1.5, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
      await expect(provider.generateUploadUrl('serviceos', 'k.jpg', 'image/jpeg', bad)).rejects.toThrow(
        /sizeBytes/
      );
    }
  });

  it('signS3Request rejects a non-integer contentLength and ignores it for non-PUT', () => {
    const base = {
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      bucket: 'examplebucket',
      key: 'a.jpg',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      expiresSeconds: 300,
      now: new Date('2013-05-24T00:00:00.000Z'),
      pathStyle: false,
    };
    expect(() => signS3Request({ ...base, method: 'PUT', contentLength: 1.5 })).toThrow(/contentLength/);
    const get = signS3Request({ ...base, method: 'GET', contentLength: 10 });
    expect(new URL(get).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
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
      'audio/webm',
      1234
    );
    const parsed = new URL(url);
    expect(parsed.host).toBe('abcdef.r2.cloudflarestorage.com');
    expect(parsed.pathname).toBe('/serviceos/tenant-1/file-1/voice.webm');
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Credential')).toContain('AKIATEST');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('percent-encodes path segments without touching slashes', async () => {
    const url = await provider.generateUploadUrl(
      'serviceos',
      'tenant-1/file-1/name with spaces.webm',
      'audio/webm',
      1234
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
  it('returns a URL under the configured public base, signed with a PUT token (#1273)', async () => {
    const provider = new DevStorageProvider({
      bucket: 'serviceos-dev',
      publicUrlBase: 'http://localhost:3000/storage-dev',
      secret: 'test-secret',
    });
    const url = await provider.generateUploadUrl(
      'serviceos-dev',
      'tenant-1/file-1/voice.webm',
      'audio/webm',
      1234
    );
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      'http://localhost:3000/storage-dev/tenant-1/file-1/voice.webm'
    );
    const token = parsed.searchParams.get('token');
    expect(token).toBe(signDevStorageToken('test-secret', 'PUT', 'tenant-1/file-1/voice.webm'));
  });

  it('signs the download URL with a distinct GET token so a PUT token cannot read it back (#1273)', async () => {
    const provider = new DevStorageProvider({
      bucket: 'serviceos-dev',
      publicUrlBase: 'http://localhost:3000/storage-dev',
      secret: 'test-secret',
    });
    const uploadUrl = await provider.generateUploadUrl('serviceos-dev', 'tenant-1/x.webm', 'audio/webm', 1234);
    const downloadUrl = await provider.generateDownloadUrl('serviceos-dev', 'tenant-1/x.webm');
    const putToken = new URL(uploadUrl).searchParams.get('token');
    const getToken = new URL(downloadUrl).searchParams.get('token');
    expect(putToken).not.toBe(getToken);
    expect(verifyDevStorageToken('test-secret', 'GET', 'tenant-1/x.webm', getToken ?? undefined)).toBe(true);
    expect(verifyDevStorageToken('test-secret', 'GET', 'tenant-1/x.webm', putToken ?? undefined)).toBe(false);
  });

  it('getObjectMetadata returns null (metadata not available)', async () => {
    const provider = new DevStorageProvider({
      bucket: 'serviceos-dev',
      publicUrlBase: 'http://localhost:3000/storage-dev',
      secret: 'test-secret',
    });
    expect(await provider.getObjectMetadata('serviceos-dev', 'tenant-1/file-1/voice.webm')).toBeNull();
  });
});

describe('signDevStorageToken / verifyDevStorageToken (#1273)', () => {
  it('verifies a token signed with the same secret/method/key', () => {
    const token = signDevStorageToken('s1', 'PUT', 'a/b/c.jpg');
    expect(verifyDevStorageToken('s1', 'PUT', 'a/b/c.jpg', token)).toBe(true);
  });

  it('rejects a missing token', () => {
    expect(verifyDevStorageToken('s1', 'PUT', 'a/b/c.jpg', undefined)).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signDevStorageToken('s1', 'PUT', 'a/b/c.jpg');
    expect(verifyDevStorageToken('s2', 'PUT', 'a/b/c.jpg', token)).toBe(false);
  });

  it('rejects a token whose method does not match (GET token used for PUT)', () => {
    const token = signDevStorageToken('s1', 'GET', 'a/b/c.jpg');
    expect(verifyDevStorageToken('s1', 'PUT', 'a/b/c.jpg', token)).toBe(false);
  });

  it('rejects a token whose key does not match', () => {
    const token = signDevStorageToken('s1', 'PUT', 'a/b/c.jpg');
    expect(verifyDevStorageToken('s1', 'PUT', 'other/key.jpg', token)).toBe(false);
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

  it('allows the dev provider in production when STORAGE_ENABLED=false', () => {
    const { provider, mode } = createStorageProvider({
      NODE_ENV: 'production',
      STORAGE_ENABLED: 'false',
    });
    expect(mode).toBe('dev');
    expect(provider).toBeInstanceOf(DevStorageProvider);
  });

  it('defaults dev public URL to an absolute localhost address', async () => {
    const { provider } = createStorageProvider({ NODE_ENV: 'development', API_PORT: '4321' });
    const url = await provider.generateUploadUrl('b', 'k', 'audio/webm', 1234);
    expect(url.startsWith('http://localhost:4321/storage-dev/')).toBe(true);
  });

  // #1273 — a browser hitting a deployed dev host cannot reach
  // http://localhost:PORT (that resolves to the browser's own machine).
  // When PUBLIC_API_URL is set (the canonical "where machines/browsers can
  // reach this API" var — see shared/config.ts), the dev presign must use
  // it instead of localhost.
  it('prefers PUBLIC_API_URL over localhost when presigning dev uploads (#1273)', async () => {
    const { provider } = createStorageProvider({
      NODE_ENV: 'development',
      PUBLIC_API_URL: 'https://dev-api.example.com',
    });
    const url = await provider.generateUploadUrl('b', 'tenant-1/k.webm', 'audio/webm', 1234);
    expect(url.startsWith('https://dev-api.example.com/storage-dev/')).toBe(true);
  });

  it('strips a trailing slash from PUBLIC_API_URL before appending /storage-dev (#1273)', async () => {
    const { provider } = createStorageProvider({
      NODE_ENV: 'development',
      PUBLIC_API_URL: 'https://dev-api.example.com/',
    });
    const url = await provider.generateUploadUrl('b', 'tenant-1/k.webm', 'audio/webm', 1234);
    expect(url.startsWith('https://dev-api.example.com/storage-dev/')).toBe(true);
    expect(url).not.toContain('.com//storage-dev');
  });

  // #1273 — the dev storage receiver must not be exposed as unauthenticated
  // attack surface when it isn't even the active backend: a "dev" host with
  // real S3 credentials configured has no business also mounting a route
  // that accepts arbitrary PUT/GET. createStorageProvider only returns a
  // devStorageSecret (app.ts's signal to mount /storage-dev) in dev mode.
  it('does not return a devStorageSecret when the S3 provider is active (#1273)', () => {
    const { mode, devStorageSecret } = createStorageProvider({
      STORAGE_BUCKET: 'b',
      STORAGE_ENDPOINT: 'https://x.example.com',
      STORAGE_REGION: 'auto',
      STORAGE_ACCESS_KEY_ID: 'k',
      STORAGE_SECRET_ACCESS_KEY: 's',
      NODE_ENV: 'development',
    });
    expect(mode).toBe('s3');
    expect(devStorageSecret).toBeUndefined();
  });

  it('returns a devStorageSecret when the dev provider is active (#1273)', () => {
    const { mode, devStorageSecret } = createStorageProvider({ NODE_ENV: 'development' });
    expect(mode).toBe('dev');
    expect(devStorageSecret).toBeTruthy();
  });
});
