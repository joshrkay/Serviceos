import type { VerticalPack, VerticalType } from '../verticals/registry';

export interface VerticalTerminologyProviderDeps {
  repo: { findByType(type: VerticalType): Promise<VerticalPack | null> };
  lookupVertical: (tenantId: string) => Promise<VerticalType | null>;
}

/**
 * Returns Deepgram keyword-boost tokens for the tenant's active vertical
 * pack. Tokens are passed straight to the Deepgram streaming URL as
 * `keywords=term1:weight,term2:weight,...`. Empty result is valid — the
 * caller omits the parameter entirely in that case.
 *
 * The 50-token cap protects Deepgram URL length and avoids degrading
 * baseline transcription quality from over-boosting.
 */
export class VerticalTerminologyProvider {
  private static readonly MAX_KEYWORDS = 50;

  constructor(private readonly deps: VerticalTerminologyProviderDeps) {}

  async getKeywords(tenantId: string): Promise<ReadonlyArray<string>> {
    const vertical = await this.deps.lookupVertical(tenantId);
    if (!vertical) return [];
    const pack = await this.deps.repo.findByType(vertical);
    const keywords = pack?.sttKeywords ?? [];
    if (keywords.length <= VerticalTerminologyProvider.MAX_KEYWORDS) {
      return keywords;
    }
    return keywords.slice(0, VerticalTerminologyProvider.MAX_KEYWORDS);
  }
}
