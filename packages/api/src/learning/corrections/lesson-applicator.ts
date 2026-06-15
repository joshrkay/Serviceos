/**
 * N-009 / P2-038 — Correction-loop config applicator.
 *
 * A lesson distilled by the extractor cascades into ONE piece of tenant
 * config. This module performs that cascade — and, crucially, reverses it on
 * undo — through small ports so the loop stays self-contained:
 *
 *   labor_rate_changed → ConfigPorts.setLaborRateCents
 *   part_price_changed → ConfigPorts.setSkuPriceCents
 *   banned_phrase      → ConfigPorts.setBannedPhrases (brand-voice negative prompt)
 *   scope_reclassified → ConfigPorts.setTemplateWeight
 *
 * Apply uses the payload's `after`; undo uses the payload's `before`, so a
 * single undo reverses exactly what was cascaded (no recompute, no drift).
 * The ports are wired against the real config stores (catalog items,
 * brand-voice settings, template weights) at the call site; tests use an
 * in-memory `FakeConfigPorts`.
 */
import type {
  CorrectionLessonPayload,
  BannedPhrasePayload,
  LaborRatePayload,
  PartPricePayload,
  ScopeReclassifiedPayload,
} from '@ai-service-os/shared';

export interface ConfigPorts {
  setLaborRateCents(tenantId: string, cents: number | null): Promise<void>;
  setSkuPriceCents(tenantId: string, catalogItemId: string, cents: number): Promise<void>;
  setBannedPhrases(tenantId: string, phrases: string[]): Promise<void>;
  setTemplateWeight(
    tenantId: string,
    packId: string,
    templateKey: string,
    weight: number,
  ): Promise<void>;
}

/** Cascade a lesson's config change forward (uses payload `after`). */
export async function applyLessonConfig(
  tenantId: string,
  payload: CorrectionLessonPayload,
  ports: ConfigPorts,
): Promise<void> {
  switch (payload.kind) {
    case 'labor_rate_changed':
      await ports.setLaborRateCents(tenantId, (payload as LaborRatePayload).afterCents);
      return;
    case 'part_price_changed': {
      const p = payload as PartPricePayload;
      await ports.setSkuPriceCents(tenantId, p.catalogItemId, p.afterCents);
      return;
    }
    case 'banned_phrase':
      await ports.setBannedPhrases(tenantId, (payload as BannedPhrasePayload).afterPhrases);
      return;
    case 'scope_reclassified': {
      const p = payload as ScopeReclassifiedPayload;
      await ports.setTemplateWeight(tenantId, p.packId, p.templateKey, p.afterWeight);
      return;
    }
  }
}

/** Reverse a lesson's cascaded config (uses payload `before`). */
export async function revertLessonConfig(
  tenantId: string,
  payload: CorrectionLessonPayload,
  ports: ConfigPorts,
): Promise<void> {
  switch (payload.kind) {
    case 'labor_rate_changed':
      await ports.setLaborRateCents(tenantId, (payload as LaborRatePayload).beforeCents);
      return;
    case 'part_price_changed': {
      const p = payload as PartPricePayload;
      // before is null only when the SKU had no prior tenant override; restore
      // to 0 would be wrong, so we leave the SKU untouched in that rare case.
      if (p.beforeCents !== null) {
        await ports.setSkuPriceCents(tenantId, p.catalogItemId, p.beforeCents);
      }
      return;
    }
    case 'banned_phrase':
      await ports.setBannedPhrases(tenantId, (payload as BannedPhrasePayload).beforePhrases);
      return;
    case 'scope_reclassified': {
      const p = payload as ScopeReclassifiedPayload;
      await ports.setTemplateWeight(tenantId, p.packId, p.templateKey, p.beforeWeight);
      return;
    }
  }
}

/**
 * In-memory ports for tests and non-DB callers. Mirrors the
 * `ExtractorConfigSnapshot` shape so a test can feed the same store into both
 * the extractor (read) and the applicator (write) and observe forward
 * application end-to-end.
 */
export class FakeConfigPorts implements ConfigPorts {
  laborRateCents: number | null;
  skuPriceCents: Record<string, number>;
  bannedPhrases: string[];
  templateWeights: Record<string, number>;

  constructor(init?: {
    laborRateCents?: number | null;
    skuPriceCents?: Record<string, number>;
    bannedPhrases?: string[];
    templateWeights?: Record<string, number>;
  }) {
    this.laborRateCents = init?.laborRateCents ?? null;
    this.skuPriceCents = { ...(init?.skuPriceCents ?? {}) };
    this.bannedPhrases = [...(init?.bannedPhrases ?? [])];
    this.templateWeights = { ...(init?.templateWeights ?? {}) };
  }

  async setLaborRateCents(_tenantId: string, cents: number | null): Promise<void> {
    this.laborRateCents = cents;
  }

  async setSkuPriceCents(_tenantId: string, catalogItemId: string, cents: number): Promise<void> {
    this.skuPriceCents[catalogItemId] = cents;
  }

  async setBannedPhrases(_tenantId: string, phrases: string[]): Promise<void> {
    this.bannedPhrases = [...phrases];
  }

  async setTemplateWeight(
    _tenantId: string,
    packId: string,
    templateKey: string,
    weight: number,
  ): Promise<void> {
    this.templateWeights[`${packId}:${templateKey}`] = weight;
  }
}
