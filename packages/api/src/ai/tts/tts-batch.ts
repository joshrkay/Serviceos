import { z } from 'zod';
import { TTS_VOICE_PRESET_SCHEMA } from './resolve-voice';

/**
 * S3-2 (plan U4) — the body of `POST /api/voice/tts/batch`: exactly one
 * onboarding turn, the question plus at most two option lines.
 *
 * The caps are sized from the choice registry (`onboarding/choices/registry`)
 * rendered at the longest substitutions the draft contract allows
 * (`{businessName}` 120, `{ownerFirstName}` 60): the longest rendered line is
 * 163 characters and the heaviest turn 362 in all, so 240 per item and 600
 * per turn leave about 1.5x and 1.7x headroom. The registry schema's own
 * ceilings (question 140, rivetLine 260) are looser than these, so the guard
 * that keeps content inside the batch is the registry test
 * (`test/onboarding/choices/registry-tts-caps.test.ts`), which imports these
 * numbers rather than copying them. Anything outside the caps is a 400
 * before any charge, cache lookup or provider call.
 */
export const TTS_BATCH_MAX_ITEMS = 3;
export const TTS_BATCH_MAX_ITEM_CHARS = 240;
export const TTS_BATCH_MAX_TURN_CHARS = 600;

export const TTS_BATCH_BODY_SCHEMA = z.object({
  items: z
    .array(z.string().trim().min(1).max(TTS_BATCH_MAX_ITEM_CHARS))
    .min(1)
    .max(TTS_BATCH_MAX_ITEMS)
    .refine((items) => items.reduce((sum, text) => sum + text.length, 0) <= TTS_BATCH_MAX_TURN_CHARS, {
      message: `A turn is at most ${TTS_BATCH_MAX_TURN_CHARS} characters in all`,
    }),
  voice: TTS_VOICE_PRESET_SCHEMA.optional(),
});
