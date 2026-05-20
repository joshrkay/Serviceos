/**
 * P7-026 PR c — Brand voice loader (stub for P4-015).
 *
 * The full brand-voice subsystem (P4-015) is not yet in the repo. PR c
 * needs a stable, typed surface so the draft composers can include
 * tone + signoff in their LLM prompts without growing a dependency on
 * something that doesn't exist yet. When P4-015 ships, the production
 * wiring swaps `NoopBrandVoiceLoader` for the real implementation —
 * one line of change at the composition root.
 *
 * Contract: `load(tenantId)` always resolves to a `BrandVoice` (never
 * throws, never returns null). The neutral value carries `tone =
 * signoff = null`; composers treat null as "don't include this in the
 * prompt".
 */

export interface BrandVoice {
  /** Free-form description of the tenant's preferred tone. */
  tone: string | null;
  /** Signature appended to the end of LLM-drafted messages. */
  signoff: string | null;
}

export const NEUTRAL_BRAND_VOICE: BrandVoice = {
  tone: null,
  signoff: null,
};

export interface BrandVoiceLoader {
  load(tenantId: string): Promise<BrandVoice>;
}

/**
 * Default loader used until P4-015 lands. Always returns the neutral
 * brand voice. Safe to wire in production — the draft composers
 * gracefully omit tone/signoff guidance when null.
 */
export class NoopBrandVoiceLoader implements BrandVoiceLoader {
  async load(_tenantId: string): Promise<BrandVoice> {
    return NEUTRAL_BRAND_VOICE;
  }
}
