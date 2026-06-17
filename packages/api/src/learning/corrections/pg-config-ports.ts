/**
 * N-009 / P2-038 — Production ConfigPorts over the real tenant config stores.
 *
 * The correction loop cascades a lesson into exactly ONE piece of tenant config
 * and reverses it on undo (see `lesson-applicator.ts`). This wires those ports
 * against the canonical stores, so a recorded lesson actually moves the dials
 * the next same-day draft reads:
 *
 *   setLaborRateCents  → tenant_settings.labor_rate_cents_per_hour (settingsRepo)
 *   setSkuPriceCents   → catalog_items.unit_price_cents            (catalogRepo)
 *   setBannedPhrases   → tenant_settings.brand_voice.banned_phrases (settingsRepo)
 *   setTemplateWeight  → NO backing store yet (see note) — logged, not silent
 *
 * Money flows through as integer cents unchanged. Each setter is tenant-scoped
 * (the underlying repos enforce tenant_id + RLS).
 */
import type { SettingsRepository } from '../../settings/settings';
import type { CatalogItemRepository } from '../../catalog/catalog-item';
import type { Logger } from '../../logging/logger';
import type { ConfigPorts } from './lesson-applicator';

export interface PgConfigPortsDeps {
  settingsRepo: SettingsRepository;
  catalogRepo: CatalogItemRepository;
  /** Used only to record the template-weight gap (no store wired yet). */
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Build a ConfigPorts backed by the settings + catalog repos.
 *
 * `setTemplateWeight` has no persistent store in the canonical product today —
 * vertical-pack template weights are not yet a tenant-config column anywhere
 * (only the extractor/applicator reference them). Rather than silently drop the
 * cascade, the port LOGS the intended change so the signal is observable; when
 * the template-weight store lands, this is the single call site to wire it. The
 * `scope_reclassified` extractor rule only fires when a caller passes a
 * `resolveTemplate`, which the production onExecuted path does not yet supply,
 * so no scope lesson reaches this no-op in practice.
 */
export function createPgConfigPorts(deps: PgConfigPortsDeps): ConfigPorts {
  const { settingsRepo, catalogRepo, logger } = deps;
  return {
    async setLaborRateCents(tenantId, cents) {
      await settingsRepo.update(tenantId, { laborRateCentsPerHour: cents });
    },

    async setSkuPriceCents(tenantId, catalogItemId, cents) {
      await catalogRepo.update(tenantId, catalogItemId, { unitPriceCents: cents });
    },

    async setBannedPhrases(tenantId, phrases) {
      const settings = await settingsRepo.findByTenant(tenantId);
      const brandVoice = { ...(settings?.brandVoice ?? {}), banned_phrases: phrases };
      await settingsRepo.update(tenantId, { brandVoice });
    },

    async setTemplateWeight(tenantId, packId, templateKey, weight) {
      logger?.warn(
        'correction-loop: setTemplateWeight has no backing store; cascade not persisted',
        { tenantId, packId, templateKey, weight },
      );
    },
  };
}
