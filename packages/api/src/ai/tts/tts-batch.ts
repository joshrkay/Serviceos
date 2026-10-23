import { z } from 'zod';
import { TTS_VOICE_PRESET_SCHEMA } from './resolve-voice';

/**
 * S3-2 (plan U4) — the body of `POST /api/voice/tts/batch`: exactly one
 * onboarding turn as Rivet narrates it (`narrateTurn` in packages/shared):
 * the question, a line per option (label, why, what callers hear), and which
 * one most shops pick.
 *
 * The caps are sized from the choice registry (`onboarding/choices/registry`)
 * narrated at the longest substitutions the draft contract allows
 * (`{businessName}` 120, `{ownerFirstName}` 60). The registry test
 * (`test/onboarding/choices/registry-tts-caps.test.ts`) imports these numbers
 * rather than copying them and pins the measured maxima, so a content PR that
 * outgrows a cap fails there. Anything outside the caps is a 400 before any
 * charge, cache lookup or provider call.
 */
export const TTS_BATCH_MAX_ITEMS = 4;
export const TTS_BATCH_MAX_ITEM_CHARS = 320;
export const TTS_BATCH_MAX_TURN_CHARS = 900;

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
