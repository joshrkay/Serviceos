import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  FeatureFlagRepository,
  InMemoryFeatureFlagStore,
  isFeatureEnabled,
} from './feature-flags';

/**
 * RV-001 — Per-tenant feature flag overrides.
 *
 * Resolution order for isEnabledForTenant:
 *   1. tenant_feature_flags row for (tenant_id, flag_key)  — RLS-scoped read
 *   2. platform _feature_flags row evaluated via isFeatureEnabled (honours
 *      environments and tenantIds scoping, not just the raw enabled bit)
 *   3. false
 *
 * Cache note: the in-process 30-second TTL is per-process only. In
 * multi-instance deployments each process caches independently, so
 * different instances may serve stale values for up to 30 s after a write.
 * setTenantFlag busts the local cache immediately so the writing process
 * sees the new value right away.
 */

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

/** Bounded by tenants × flag keys; flag keys are code constants so growth is predictable. */
type CacheKey = `${string}:${string}`;

function cacheKey(tenantId: string, flagKey: string): CacheKey {
  return `${tenantId}:${flagKey}`;
}

export class PgTenantFeatureFlagRepository extends PgBaseRepository {
  private readonly platformRepo: FeatureFlagRepository;
  private readonly cache = new Map<CacheKey, CacheEntry>();

  /**
   * @param pool          Pool used for tenant-scoped reads (withTenant sets RLS context)
   * @param platformFlags Repository used for global _feature_flags reads
   */
  constructor(pool: Pool, platformFlags: FeatureFlagRepository) {
    super(pool);
    this.platformRepo = platformFlags;
  }

  /**
   * Resolve whether a feature flag is enabled for a specific tenant.
   *
   * Resolution order:
   *  1. Tenant override row in tenant_feature_flags (RLS-filtered read)
   *  2. Platform flag evaluated via isFeatureEnabled (environments + tenantIds honoured)
   *  3. false
   *
   * Cache note: reads are cached for CACHE_TTL_MS (30 s) per-process only.
   * Multi-instance deployments may serve stale values for up to 30 s.
   * setTenantFlag busts the local cache immediately for the affected key.
   */
  async isEnabledForTenant(tenantId: string, flagKey: string): Promise<boolean> {
    const key = cacheKey(tenantId, flagKey);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = await this._resolve(tenantId, flagKey);
    this.cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  }

  private async _resolve(tenantId: string, flagKey: string): Promise<boolean> {
    // 1. Check tenant override (RLS-scoped, belt-and-braces composite PK lookup)
    const tenantOverride = await this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT enabled FROM tenant_feature_flags WHERE tenant_id = $1 AND flag_key = $2`,
        [tenantId, flagKey]
      );
      if (result.rows.length === 0) return null;
      return result.rows[0].enabled as boolean;
    });

    if (tenantOverride !== null) {
      return tenantOverride;
    }

    // 2. Fall back to platform flag — evaluated with full isFeatureEnabled semantics
    //    (honours environments and tenantIds scoping, not just the raw enabled bit)
    const platformFlag = await this.platformRepo.get(flagKey);
    if (platformFlag !== null) {
      const store = new InMemoryFeatureFlagStore([platformFlag]);
      return isFeatureEnabled(store, flagKey, {
        environment: process.env.NODE_ENV ?? 'development',
        tenantId,
      });
    }

    // 3. Default: disabled
    return false;
  }

  /**
   * Upsert a per-tenant flag override.
   *
   * Uses ON CONFLICT (tenant_id, flag_key) DO UPDATE so repeated calls
   * are idempotent and always reflect the latest value. Busts the
   * in-process cache for (tenantId, flagKey) immediately after the write.
   *
   * @param updatedBy  Optional UUID of the admin/user making the change (for audit trail)
   */
  async setTenantFlag(
    tenantId: string,
    flagKey: string,
    enabled: boolean,
    updatedBy?: string
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, flag_key) DO UPDATE SET
           enabled    = EXCLUDED.enabled,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [tenantId, flagKey, enabled, updatedBy ?? null]
      );
    });

    // Bust cache immediately so the next read sees the new value
    this.cache.delete(cacheKey(tenantId, flagKey));
  }
}
