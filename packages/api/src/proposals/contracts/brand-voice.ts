import { z } from 'zod';
import { brandVoiceSchema } from '../../tenants/brand/brand-voice';

/**
 * B1.18 — update_brand_voice proposal payload.
 *
 * REUSES `brandVoiceSchema` (tenants/brand/brand-voice.ts) verbatim for the
 * six configured fields rather than restating them here, so a future field
 * addition to the Brand-Voice Configurator can't drift between the form
 * surface and the voice surface (see b1.18-design.md).
 *
 * `freeText` is additive: AC-2 requires that nothing the speaker said is
 * dropped, but the six fields are a bounded enum/length vocabulary that
 * cannot represent every spoken instruction ("keep it under two sentences",
 * "never mention pricing over the phone"). Unmapped instructions land here
 * verbatim instead of being silently discarded. It carries NO field capable
 * of expressing `brand_voice_locked` — see AC-4: a spoken "lock my brand
 * voice" cannot set that column through this payload no matter how it
 * classifies, by construction.
 */
export const updateBrandVoicePayloadSchema = brandVoiceSchema.extend({
  freeText: z.string().trim().min(1).max(1000).optional(),
});

export type UpdateBrandVoicePayload = z.infer<typeof updateBrandVoicePayloadSchema>;
