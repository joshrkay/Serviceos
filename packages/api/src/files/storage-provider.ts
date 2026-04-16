import { createHash, createHmac } from 'crypto';
import { StorageProvider } from './file-service';

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
}

export interface StorageProviderEnv {
  STORAGE_BUCKET?: string;
  STORAGE_ENDPOINT?: string;
  STORAGE_REGION?: string;
  STORAGE_ACCESS_KEY_ID?: string;
  STORAGE_SECRET_ACCESS_KEY?: string;
  STORAGE_PUBLIC_URL?: string;
  NODE_ENV?: string;
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

export class S3StorageProvider implements StorageProvider {
  private readonly config: Required<Omit<S3StorageConfig, 'publicUrlBase' | 'pathStyle'>> &
    Pick<S3StorageConfig, 'publicUrlBase' | 'pathStyle'>;

  constructor(config: S3StorageConfig) {
    this.config = {
      ...config,
      pathStyle: config.pathStyle ?? true,
    };
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

  async deleteObject(bucket: string, key: string): Promise<void> {
    const url = this.presign('DELETE', bucket, key, 60);
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      throw new Error(`S3 delete failed ${res.status}: ${await res.text()}`);
    }
  }

  private presign(
    method: 'GET' | 'PUT' | 'DELETE',
    bucket: string,
    key: string,
    expiresSeconds: number,
    _contentType?: string
  ): string {
    const { endpoint, region, accessKeyId, secretAccessKey, pathStyle } = this.config;
    const now = new Date();
    const { amzDate: ts, dateStamp } = amzDate(now);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const credential = `${accessKeyId}/${scope}`;

    const endpointUrl = new URL(endpoint);
    const host = endpointUrl.host;
    const basePath = endpointUrl.pathname.replace(/\/$/, '');
    const encodedKey = encodeKeyPath(key);
    const canonicalPath = pathStyle
      ? `${basePath}/${bucket}/${encodedKey}`
      : `${basePath}/${encodedKey}`;

    const params: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': credential,
      'X-Amz-Date': ts,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalQuery = Object.keys(params)
      .sort()
      .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
      .join('&');

    const canonicalHeaders = `host:${host}\n`;
    const canonicalRequest = [
      method,
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      'host',
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
}

// Dev provider used when no S3 credentials are configured. The returned
// upload URL points at a local route that accepts PUTs and discards the
// payload — enough for the voice pipeline to exercise the happy path in
// local development, where the dev transcription provider does not fetch
// audio bytes anyway. In prod the config validator rejects this path.
export class DevStorageProvider implements StorageProvider {
  constructor(private readonly config: DevStorageConfig) {}

  async generateUploadUrl(_bucket: string, key: string, _contentType: string): Promise<string> {
    return `${this.config.publicUrlBase.replace(/\/$/, '')}/${encodeKeyPath(key)}`;
  }

  async generateDownloadUrl(_bucket: string, key: string): Promise<string> {
    return `${this.config.publicUrlBase.replace(/\/$/, '')}/${encodeKeyPath(key)}`;
  }

  async deleteObject(): Promise<void> {
    return;
  }
}

export function createStorageProvider(env: StorageProviderEnv = process.env): {
  provider: StorageProvider;
  bucket: string;
  mode: 's3' | 'dev';
} {
  const {
    STORAGE_BUCKET,
    STORAGE_ENDPOINT,
    STORAGE_REGION,
    STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY,
    STORAGE_PUBLIC_URL,
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

  if (NODE_ENV === 'prod' || NODE_ENV === 'staging') {
    throw new Error(
      'Storage configuration missing: set STORAGE_BUCKET, STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY'
    );
  }

  const bucket = STORAGE_BUCKET || 'serviceos-dev';
  const publicUrlBase = STORAGE_PUBLIC_URL || '/storage-dev';
  return {
    provider: new DevStorageProvider({ bucket, publicUrlBase }),
    bucket,
    mode: 'dev',
  };
}
