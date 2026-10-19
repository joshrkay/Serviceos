import type { TtsProvider, TtsSynthesizeInput, TtsSynthesizeResult, TtsVoicePreset } from './tts-provider';

/**
 * S3-6 (plan U4) — a speech provider for the real-stack e2e lane
 * (`e2e/onboarding-v3.config.ts`, `TTS_PROVIDER=fixture`): every line is the
 * same 200 ms silent mp3, so the browser really plays a clip after the owner's
 * tap with no vendor key. It sits at the vendor boundary only: the voice
 * routes, the clip cache, the per-clip charge and the audit all run for real.
 *
 * SAFETY: never in production, same posture as `NoopTtsProvider`: an owner
 * would hear silence and think Rivet had nothing to say. The constructor
 * throws there, and so does `createTtsProvider`, so a mis-set deploy fails at
 * boot rather than going quiet.
 *
 * The clip is embedded (MPEG-2 Layer III, 22.05 kHz mono, 32 kb/s, made with
 * `ffmpeg -f lavfi -i anullsrc=r=22050:cl=mono -t 0.2 -c:a libmp3lame -b:a 32k`)
 * because the build emits to `dist/`, where a file beside the source is not.
 */
const SILENT_MP3 = Buffer.from(
  '//NwwAAAAAAAAAAAAEluZm8AAAAPAAAACgAABMsAOzs7Ozs7Ozs7UVFRUVFRUVFRUWdnZ2dnZ2dnZ2d9fX19fX19fX19kpKSkpKSkpKSkqioqKioqKioqKi+vr6+vr6+vr6+1NTU1NTU1NTU1Orq6urq6urq6ur/////////////AAAAAExhdmM2MC4zMQAAAAAAAAAAAAAAACQDBgAAAAAAAATL+A9CeQAAAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsRbAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NAxKQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEowAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80DEpAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsSjAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV',
  'base64',
);

export class FixtureTtsProvider implements TtsProvider {
  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FixtureTtsProvider cannot be used in production: it speaks silence. Set a real TTS_PROVIDER.');
    }
  }

  synthesize(_input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> {
    return Promise.resolve({ audio: Buffer.from(SILENT_MP3), contentType: 'audio/mpeg', provider: 'fixture-tts', durationMs: 200 });
  }

  /** Each preset is its own cache voice, so the lane caches per voice as a real catalogue does. */
  voiceForPreset(preset: TtsVoicePreset): string {
    return `fixture:${preset.id}`;
  }
}
