/**
 * #1588 — the voice capability flags that ship DEFAULT-ON.
 *
 * `voice_extended_intents` (owner-extended lookups: day overview, digest,
 * pending items, crew schedule, timesheets — and the complaint/negotiation
 * sections the classifier appends with it) was read by app.ts but never
 * seeded for any tenant, so on the live owner line, in-app voice and the
 * recorded memo those intents never ran, while chat set them unconditionally.
 * `multiActionEnabled` (one sentence → an ordered chain of linked proposals)
 * was accepted by the memo router and never passed at all.
 *
 * Both now resolve through the repo's default-on pattern (U3,
 * `PgTenantFeatureFlagRepository.isEnabledForTenantWithDefault`):
 *
 *   1. a `tenant_feature_flags` override row decides — `enabled=false` is the
 *      owner's opt-OUT kill switch, `enabled=true` keeps it on;
 *   2. else a platform `_feature_flags` row decides (a platform-level
 *      kill switch, with its environments/tenantIds scoping honoured);
 *   3. else ON.
 *
 * Order 1 → 2 keeps the shipped precedent that a tenant's own decision wins
 * over the platform ramp (docs/audit/blocked-on-josh.md, #1011 §E3). Without
 * a pool (dev / in-memory tests) there is no override table, so only 2 → 3
 * apply — default-on holds in every environment, exactly like the
 * supervisor gate.
 */
import {
  InMemoryFeatureFlagStore,
  isFeatureEnabled,
  type FeatureFlagRepository,
} from './feature-flags';

export const VOICE_EXTENDED_INTENTS_FLAG = 'voice_extended_intents';
export const VOICE_MULTI_ACTION_FLAG = 'voice_multi_action';

/** The per-tenant reader the resolver needs — `PgTenantFeatureFlagRepository` satisfies it. */
export interface TenantFlagDefaultReader {
  isEnabledForTenantWithDefault(
    tenantId: string,
    flagKey: string,
    defaultEnabled: boolean,
  ): Promise<boolean>;
}

export interface VoiceFlagResolverDeps {
  /** `null` when there is no pool (no `tenant_feature_flags` table). */
  tenantFeatureFlags: TenantFlagDefaultReader | null;
  /** Platform `_feature_flags` — the platform-level kill switch. */
  featureFlagRepo: FeatureFlagRepository;
}

export interface VoiceFlagResolver {
  /** Owner-extended lookups + protection sections offered to the classifier. */
  extendedIntentsEnabled(tenantId: string): Promise<boolean>;
  /** Memo router: one sentence → an ordered chain of linked proposals. */
  multiActionEnabled(tenantId: string): Promise<boolean>;
}

export function createVoiceFlagResolver(deps: VoiceFlagResolverDeps): VoiceFlagResolver {
  const resolve = async (tenantId: string, flagKey: string): Promise<boolean> => {
    // 1 → 2 → 3 with a pool: the repo's own default-on resolution (tenant
    //    override → platform flag → default), the U3 supervisor-gate path.
    if (deps.tenantFeatureFlags) {
      return deps.tenantFeatureFlags.isEnabledForTenantWithDefault(tenantId, flagKey, true);
    }
    // 2. Platform kill switch — evaluated with full isFeatureEnabled semantics
    //    (environments + tenantIds scoping), the same way `_resolve` does.
    const platformFlag = await deps.featureFlagRepo.get(flagKey);
    if (platformFlag !== null) {
      return isFeatureEnabled(new InMemoryFeatureFlagStore([platformFlag]), flagKey, {
        environment: process.env.NODE_ENV ?? 'development',
        tenantId,
      });
    }
    // 3. Default: ON.
    return true;
  };
  return {
    extendedIntentsEnabled: (tenantId) => resolve(tenantId, VOICE_EXTENDED_INTENTS_FLAG),
    multiActionEnabled: (tenantId) => resolve(tenantId, VOICE_MULTI_ACTION_FLAG),
  };
}
