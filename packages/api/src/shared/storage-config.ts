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
 * variables (R2_*) are an alias, used for whatever STORAGE_* did not supply —
 * except under the explicit opt-out STORAGE_ENABLED=false, where the alias is
 * not consulted: an operator who turned storage off (typically leaving the R2_*
 * they had set while following the checklist) must not see that environment
 * silently start writing to a bucket on the next deploy. A COMPLETE STORAGE_*
 * set still resolves under the opt-out, exactly as the factory always did.
 *
 * Dependency-free on purpose: shared/config.ts runs before most modules are
 * wired and must not grow imports.
 */

export interface StorageConfigEnv {
  /** Explicit opt-out; only the literal 'false' counts (unset = enabled). */
  STORAGE_ENABLED?: string;
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
  /**
   * `missing` names only what is still unresolved, canonical name first with
   * its alias in parentheses, in a stable bucket → endpoint → region → keys
   * order — ready to splice into a boot error.
   */
  | { ok: false; missing: string[] };

/** Mirrors the `R2_BUCKET` default in shared/config.ts's schema. */
const DEFAULT_R2_BUCKET = 'serviceos-uploads';

export function resolveStorageConfig(env: StorageConfigEnv): StorageConfigResolution {
  const optedOut = env.STORAGE_ENABLED === 'false';
  const r2Account = optedOut ? undefined : env.R2_ACCOUNT_ID || undefined;
  const r2Bucket = optedOut ? undefined : env.R2_BUCKET;
  const r2AccessKeyId = optedOut ? undefined : env.R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = optedOut ? undefined : env.R2_SECRET_ACCESS_KEY;

  const bucket = env.STORAGE_BUCKET || r2Bucket || (r2Account ? DEFAULT_R2_BUCKET : undefined);
  const endpoint =
    env.STORAGE_ENDPOINT ||
    (r2Account ? `https://${r2Account}.r2.cloudflarestorage.com` : undefined);
  const region =
    env.STORAGE_REGION || (!env.STORAGE_ENDPOINT && r2Account ? 'auto' : undefined);

  // An access key id is only meaningful with ITS secret: a pair assembled from
  // two families authenticates as nobody and would surface as a 403 on the
  // first upload instead of a boot error. Take a complete canonical pair, else
  // a complete R2 pair, else neither.
  const keys =
    env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY
      ? { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY }
      : r2AccessKeyId && r2SecretAccessKey
        ? { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey }
        : undefined;

  if (!bucket || !endpoint || !region || !keys) {
    const missing: string[] = [];
    if (!bucket) missing.push('STORAGE_BUCKET (or R2_BUCKET)');
    if (!endpoint) missing.push('STORAGE_ENDPOINT (or R2_ACCOUNT_ID)');
    if (!region) missing.push('STORAGE_REGION');
    if (!keys) {
      const anyKey =
        env.STORAGE_ACCESS_KEY_ID ||
        env.STORAGE_SECRET_ACCESS_KEY ||
        r2AccessKeyId ||
        r2SecretAccessKey;
      if (anyKey) {
        missing.push(
          'a complete access-key pair (STORAGE_ACCESS_KEY_ID + STORAGE_SECRET_ACCESS_KEY, ' +
            'or R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY — a key pair cannot be mixed across families)'
        );
      } else {
        missing.push('STORAGE_ACCESS_KEY_ID (or R2_ACCESS_KEY_ID)');
        missing.push('STORAGE_SECRET_ACCESS_KEY (or R2_SECRET_ACCESS_KEY)');
      }
    }
    return { ok: false, missing };
  }
  return { ok: true, config: { bucket, endpoint, region, ...keys } };
}
