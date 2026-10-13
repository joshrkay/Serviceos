/**
 * Object-storage env contract — the ONE place that decides what S3-compatible
 * storage configuration a process environment describes.
 *
 * Both consumers call this resolver, so they cannot disagree about which
 * variables count:
 *   - `createStorageProvider` (files/storage-provider.ts) builds the provider
 *     from the resolved config;
 *   - `validateFeatureRequiredConfig` (shared/config.ts) fails prod/staging
 *     boot when no config resolves and the operator has not opted out.
 *
 * Canonical variables (STORAGE_*) always win. The documented Cloudflare R2
 * variables (R2_*) are an alias, used for whatever STORAGE_* did not supply.
 *
 * Dependency-free on purpose: shared/config.ts runs before most modules are
 * wired and must not grow imports.
 */

export interface StorageConfigEnv {
  STORAGE_BUCKET?: string;
  STORAGE_ENDPOINT?: string;
  STORAGE_REGION?: string;
  STORAGE_ACCESS_KEY_ID?: string;
  STORAGE_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
}

export interface ResolvedStorageConfig {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type StorageConfigResolution =
  | { ok: true; config: ResolvedStorageConfig }
  | { ok: false };

/** Mirrors the `R2_BUCKET` default in shared/config.ts's schema. */
const DEFAULT_R2_BUCKET = 'serviceos-uploads';

export function resolveStorageConfig(env: StorageConfigEnv): StorageConfigResolution {
  const r2Account = env.R2_ACCOUNT_ID || undefined;

  const bucket = env.STORAGE_BUCKET || env.R2_BUCKET || (r2Account ? DEFAULT_R2_BUCKET : undefined);
  const endpoint =
    env.STORAGE_ENDPOINT ||
    (r2Account ? `https://${r2Account}.r2.cloudflarestorage.com` : undefined);
  const region =
    env.STORAGE_REGION || (!env.STORAGE_ENDPOINT && r2Account ? 'auto' : undefined);
  const accessKeyId = env.STORAGE_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.STORAGE_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;

  if (!bucket || !endpoint || !region || !accessKeyId || !secretAccessKey) {
    return { ok: false };
  }
  return { ok: true, config: { bucket, endpoint, region, accessKeyId, secretAccessKey } };
}
