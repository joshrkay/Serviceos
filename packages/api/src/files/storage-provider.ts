import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ObjectMetadata, StorageProvider } from './file-service';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrlBase?: string;
  pathStyle?: boolean;
}

export interface DevStorageConfig {
  bucket: string;
  publicUrlBase: string;
  /**
   * HMAC secret binding presigned dev-storage URLs (#1273). Without this,
   * `/storage-dev/*` accepts any PUT/GET unauthenticated — the presigned
   * URL's own token is the only thing standing in for a real S3 signature.
   * Optional here so direct test construction of a `DevStorageProvider` as
   * a plain `StorageProvider` stub keeps working; createStorageProvider()
   * always supplies a fresh per-boot secret for the real dev path.
   */
  secret?: string;
}

export interface StorageProviderEnv {
  STORAGE_BUCKET?: string;
  STORAGE_ENDPOINT?: string;
  STORAGE_REGION?: string;
  STORAGE_ACCESS_KEY_ID?: string;
  STORAGE_SECRET_ACCESS_KEY?: string;
  STORAGE_PUBLIC_URL?: string;
  /** Explicit opt-out aligned with validateFeatureRequiredConfig. */
  STORAGE_ENABLED?: string;
  API_PORT?: string;
  PORT?: string;
  NODE_ENV?: string;
  /**
   * Where machines/browsers reach this API from outside the process
   * (shared/config.ts's canonical "public API base" var — see its
   * PUBLIC_API_URL doc comment). #1273: a browser on a deployed dev host
   * cannot reach `http://localhost:PORT` (that's the browser's own
   * machine), so the dev presign must prefer this over the localhost
   * fallback when it's set.
   */
  PUBLIC_API_URL?: string;
}

// #1273 — signs a dev-storage URL so hitting `/storage-dev/*` directly
// (without having gone through a real presign call first) is rejected.
// Not a security boundary in the SigV4 sense (single static per-boot
// secret, no expiry) — it exists only to close the "mounted
// unauthenticated" gap while keeping the plain `fetch()` PUT/GET the web
// client already does (no Bearer header, same as a real S3 presigned URL).
export function signDevStorageToken(secret: string, method: 'GET' | 'PUT', key: string): string {
  return createHmac('sha256', secret).update(`${method}:${key}`).digest('hex');
}

export function verifyDevStorageToken(
  secret: string,
  method: 'GET' | 'PUT',
  key: string,
  token: string | undefined
): boolean {
  if (!token) return false;
  const expected = Buffer.from(signDevStorageToken(secret, method, key), 'hex');
  const actual = Buffer.from(token, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

const DEFAULT_UPLOAD_EXPIRES_SECONDS = 300;

function sha256Hex(payload: string | Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

function amzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export interface SignS3RequestInput {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now: Date;
  pathStyle: boolean;
  // When provided, binds the Content-Type into the signature so a client
  // cannot PUT a different MIME type than what the server validated.
  contentType?: string;
}

// Pure SigV4 presign. Exported for test vector verification.
export function signS3Request(input: SignS3RequestInput): string {
  const {
    method,
    endpoint,
    region,
    bucket,
    key,
    accessKeyId,
    secretAccessKey,
    expiresSeconds,
    now,
    pathStyle,
    contentType,
  } = input;
  const { amzDate: ts, dateStamp } = amzDate(now);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${accessKeyId}/${scope}`;

  const endpointUrl = new URL(endpoint);
  // Virtual-hosted style prepends the bucket onto the endpoint host; path
  // style keeps the host bare and puts the bucket in the path. Passing a
  // bare regional endpoint (e.g. https://s3.amazonaws.com) is the
  // conventional caller contract for both styles.
  const host = pathStyle ? endpointUrl.host : `${bucket}.${endpointUrl.host}`;
  const basePath = endpointUrl.pathname.replace(/\/$/, '');
  const encodedKey = encodeKeyPath(key);
  const canonicalPath = pathStyle
    ? `${basePath}/${bucket}/${encodedKey}`
    : `${basePath}/${encodedKey}`;

  const signContentType = !!contentType && method === 'PUT';
  const signedHeaders = signContentType ? 'content-type;host' : 'host';

  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': ts,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join('&');

  const canonicalHeaders = signContentType
    ? `content-type:${contentType}\nhost:${host}\n`
    : `host:${host}\n`;
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    ts,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const scheme = endpointUrl.protocol.replace(':', '');
  return `${scheme}://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// fetch has no default timeout — a stalled S3 endpoint would hang the
// image/voice pipelines and recording uploads indefinitely. Metadata ops get
// a short bound; object transfers a generous one.
const S3_METADATA_TIMEOUT_MS = 10_000;
const S3_TRANSFER_TIMEOUT_MS = 60_000;

export class S3StorageProvider implements StorageProvider {
  private readonly config: Required<Omit<S3StorageConfig, 'publicUrlBase' | 'pathStyle'>> &
    Pick<S3StorageConfig, 'publicUrlBase' | 'pathStyle'>;

  constructor(config: S3StorageConfig) {
    this.config = { ...config, pathStyle: config.pathStyle ?? true };
  }

  async generateUploadUrl(bucket: string, key: string, contentType: string): Promise<string> {
    return this.presign('PUT', bucket, key, DEFAULT_UPLOAD_EXPIRES_SECONDS, contentType);
  }

  async generateDownloadUrl(bucket: string, key: string): Promise<string> {
    if (this.config.publicUrlBase) {
      return `${this.config.publicUrlBase.replace(/\/$/, '')}/${encodeKeyPath(key)}`;
    }
    return this.presign('GET', bucket, key, DEFAULT_UPLOAD_EXPIRES_SECONDS);
  }

  async getObjectMetadata(bucket: string, key: string): Promise<ObjectMetadata | null> {
    const url = this.presign('HEAD', bucket, key, 60);
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(S3_METADATA_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 HEAD failed ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const lenHeader = res.headers.get('content-length');
    const contentLength = lenHeader ? Number(lenHeader) : 0;
    const contentType = res.headers.get('content-type') || '';
    return { contentLength, contentType };
  }

  async getObject(bucket: string, key: string): Promise<Buffer | null> {
    // Always a presigned GET (never publicUrlBase) — pipeline reads must
    // work for private buckets.
    const url = this.presign('GET', bucket, key, 60);
    const res = await fetch(url, { signal: AbortSignal.timeout(S3_TRANSFER_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 GET failed ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void> {
    // Content-Type is bound into the signature (same guarantee as client
    // presigned uploads): the stored object's MIME type matches what the
    // pipeline produced.
    const url = this.presign('PUT', bucket, key, 60, contentType);
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(S3_TRANSFER_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`S3 PUT failed ${res.status}: ${await res.text().catch(() => '')}`);
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const url = this.presign('DELETE', bucket, key, 60);
    const res = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(S3_METADATA_TIMEOUT_MS) });
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      throw new Error(`S3 delete failed ${res.status}: ${await res.text()}`);
    }
  }

  private presign(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    bucket: string,
    key: string,
    expiresSeconds: number,
    contentType?: string
  ): string {
    const { endpoint, region, accessKeyId, secretAccessKey, pathStyle } = this.config;
    return signS3Request({
      method,
      endpoint,
      region,
      bucket,
      key,
      accessKeyId,
      secretAccessKey,
      expiresSeconds,
      now: new Date(),
      pathStyle: pathStyle ?? true,
      contentType,
    });
  }
}

// Dev provider used when no S3 credentials are configured. The returned
// URL points at the API's own /storage-dev receiver which accepts PUTs
// and discards the payload — enough for the voice pipeline to exercise
// the happy path in local development, where the dev transcription
// provider does not fetch audio bytes anyway. In prod the factory
// refuses to return this provider.
export class DevStorageProvider implements StorageProvider {
  private readonly secret: string;

  constructor(private readonly config: DevStorageConfig) {
    // Generated once per instance (in practice once per process boot, via
    // createStorageProvider) when the caller doesn't supply one — plain
    // `new DevStorageProvider(...)` test stubs never exercise the actual
    // /storage-dev route, so an ungoverned random secret there is harmless.
    this.secret = config.secret ?? randomBytes(32).toString('hex');
  }

  async generateUploadUrl(_bucket: string, key: string, _contentType: string): Promise<string> {
    const token = signDevStorageToken(this.secret, 'PUT', key);
    return `${this.config.publicUrlBase.replace(/\/$/, '')}/${encodeKeyPath(key)}?token=${token}`;
  }

  async generateDownloadUrl(_bucket: string, key: string): Promise<string> {
    const token = signDevStorageToken(this.secret, 'GET', key);
    return `${this.config.publicUrlBase.replace(/\/$/, '')}/${encodeKeyPath(key)}?token=${token}`;
  }

  async getObjectMetadata(): Promise<ObjectMetadata | null> {
    return null;
  }

  // The dev receiver discards uploaded bytes, so there is nothing to fetch:
  // returning null tells the image pipeline to skip processing locally.
  async getObject(): Promise<Buffer | null> {
    return null;
  }

  async putObject(): Promise<void> {
    return;
  }

  async deleteObject(): Promise<void> {
    return;
  }
}

// Production environments canonicalize NODE_ENV to 'prod'/'staging' but
// the raw value 'production' is a common accident; treat both as prod
// so a missing STORAGE_* credential fails fast instead of silently
// returning a dev provider.
function isProductionLikeEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'prod' || nodeEnv === 'production' || nodeEnv === 'staging';
}

function defaultDevPublicUrl(env: StorageProviderEnv): string {
  // #1273 — PUBLIC_API_URL is where machines/browsers reach this API from
  // outside the process; localhost:PORT only resolves for a caller on the
  // same machine as the API, which a browser on a deployed dev host is not.
  if (env.PUBLIC_API_URL) {
    return `${env.PUBLIC_API_URL.replace(/\/+$/, '')}/storage-dev`;
  }
  const port = env.API_PORT || env.PORT || '3000';
  return `http://localhost:${port}/storage-dev`;
}

export function createStorageProvider(env: StorageProviderEnv = process.env): {
  provider: StorageProvider;
  bucket: string;
  mode: 's3' | 'dev';
  /**
   * Set only when `mode === 'dev'` — app.ts's signal both that
   * DevStorageProvider is the active backend (mount the receiver at all)
   * and the secret to verify its tokens with (#1273).
   */
  devStorageSecret?: string;
} {
  const {
    STORAGE_BUCKET,
    STORAGE_ENDPOINT,
    STORAGE_REGION,
    STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY,
    STORAGE_PUBLIC_URL,
    STORAGE_ENABLED,
    NODE_ENV,
  } = env;

  const hasS3 =
    STORAGE_BUCKET &&
    STORAGE_ENDPOINT &&
    STORAGE_REGION &&
    STORAGE_ACCESS_KEY_ID &&
    STORAGE_SECRET_ACCESS_KEY;

  if (hasS3) {
    return {
      provider: new S3StorageProvider({
        bucket: STORAGE_BUCKET!,
        endpoint: STORAGE_ENDPOINT!,
        region: STORAGE_REGION!,
        accessKeyId: STORAGE_ACCESS_KEY_ID!,
        secretAccessKey: STORAGE_SECRET_ACCESS_KEY!,
        publicUrlBase: STORAGE_PUBLIC_URL,
      }),
      bucket: STORAGE_BUCKET!,
      mode: 's3',
    };
  }

  // Match validateFeatureRequiredConfig: STORAGE_ENABLED=false opts out of
  // object storage in prod/staging (recordings/uploads stay unavailable).
  const storageOptedOut = STORAGE_ENABLED === 'false';
  if (isProductionLikeEnv(NODE_ENV) && !storageOptedOut) {
    throw new Error(
      'Storage configuration missing: set STORAGE_BUCKET, STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY'
    );
  }

  const bucket = STORAGE_BUCKET || 'serviceos-dev';
  const publicUrlBase = STORAGE_PUBLIC_URL || defaultDevPublicUrl(env);
  // Fresh per-boot secret — never persisted, never logged, only ever held
  // by this DevStorageProvider instance and the /storage-dev router app.ts
  // wires up alongside it (#1273).
  const devStorageSecret = randomBytes(32).toString('hex');
  return {
    provider: new DevStorageProvider({ bucket, publicUrlBase, secret: devStorageSecret }),
    bucket,
    mode: 'dev',
    devStorageSecret,
  };
}
