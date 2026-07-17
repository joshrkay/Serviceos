import { ElevenLabsStreamConnection } from './elevenlabs-stream';

/**
 * Text-to-speech provider interface for hands-free voice readback.
 *
 * The voice pipeline optionally reads back a proposal's summary to
 * the operator ("I've drafted an invoice for Sarah Chen, $450. Say
 * approve or cancel.") so they can keep hands on tools. Only SAFE
 * proposals are voice-approvable: money / comms / irreversible
 * actions still require screen-tap per CLAUDE.md "Never auto-execute"
 * and Decision 3.
 *
 * The TTS layer is a pluggable provider behind a small interface —
 * the default implementation talks to OpenAI `tts-1`, but the
 * contract is deliberately simple enough to swap for ElevenLabs
 * or a local Piper instance later.
 */

export interface TtsSynthesizeInput {
  text: string;
  /** ISO voice identifier. OpenAI accepts 'alloy'|'echo'|'fable'|'onyx'|'nova'|'shimmer'. */
  voice?: string;
  /** Optional per-tenant id for cost accounting and routing. */
  tenantId?: string;
  /**
   * P11-002: language code for the text being synthesized. Threads through
   * to provider-specific voice/model selection (ElevenLabs multilingual
   * model, OpenAI tts-1 with es voice). Defaults to 'en' downstream.
   */
  language?: 'en' | 'es';
}

export interface TtsSynthesizeResult {
  /** Raw audio bytes. Caller decides whether to persist to S3. */
  audio: Buffer;
  /** MIME type — 'audio/mpeg' for OpenAI tts-1. */
  contentType: string;
  /** Provider identifier for observability. */
  provider: string;
  /** Approximate duration in milliseconds (provider may estimate). */
  durationMs?: number;
}

export interface TtsStreamChunk {
  /** PCM 16-bit signed little-endian @ 16 kHz mono. */
  pcm: Buffer;
  /** True on the final chunk; the iterator MUST yield one chunk with isFinal=true even if empty. */
  isFinal: boolean;
}

export interface TtsSynthesizeStreamInput extends TtsSynthesizeInput {
  /**
   * Aborted by the caller when caller barges in mid-utterance. Stream
   * iterators MUST stop yielding promptly when this fires.
   */
  signal?: AbortSignal;
}

export interface TtsProvider {
  synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult>;
  /**
   * Optional WebSocket-backed streaming variant. When present, the
   * media-streams adapter prefers it because it removes ~400-800ms of
   * pre-first-frame buffering.
   *
   * Implementations MUST yield at least one chunk (even if empty) with
   * isFinal=true so consumers can detect end-of-stream.
   */
  synthesizeStream?(input: TtsSynthesizeStreamInput): AsyncIterable<TtsStreamChunk>;
}

/**
 * OpenAI tts-1 implementation. Uses the same AI_PROVIDER_API_KEY as
 * the rest of the gateway, so no new credentials are required. If
 * you want a different voice service, swap this class at the
 * `createTtsProvider` factory in app.ts.
 */
// Upper bound for one blocking synthesize() call across providers.
const TTS_SYNTH_TIMEOUT_MS = 30_000;

export class OpenAiTtsProvider implements TtsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'tts-1'
  ) {
    if (!apiKey) throw new Error('OpenAiTtsProvider requires AI_PROVIDER_API_KEY');
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> {
    // P11-002: OpenAI tts-1 has no explicit language parameter, but the
    // 'nova' voice handles Spanish more naturally than 'alloy'. Pick a
    // language-appropriate default when the caller doesn't override.
    const defaultVoice = input.language === 'es' ? 'nova' : 'alloy';
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: input.text,
        voice: input.voice ?? defaultVoice,
        response_format: 'mp3',
      }),
      // fetch has no default timeout — a stalled TTS vendor would hang the
      // voice turn indefinitely (the streaming path threads its own signal).
      signal: AbortSignal.timeout(TTS_SYNTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI TTS request failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      audio: buffer,
      contentType: 'audio/mpeg',
      provider: 'openai-tts-1',
    };
  }
}

/**
 * ElevenLabs TTS implementation. Uses `eleven_turbo_v2_5` which generates
 * audio in ~250 ms (vs ~800 ms for OpenAI tts-1), cutting time-to-first-audio
 * for the calling agent's spoken responses. Requires ELEVENLABS_API_KEY.
 *
 * Default voice is "Rachel" (21m00Tcm4TlvDq8ikWAM) — clear, professional,
 * US English. Override with a custom voice ID via the constructor.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string = '21m00Tcm4TlvDq8ikWAM',
    private readonly modelId: string = 'eleven_turbo_v2_5'
  ) {
    if (!apiKey) throw new Error('ElevenLabsTtsProvider requires ELEVENLABS_API_KEY');
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> {
    // P11-002: ElevenLabs Spanish synthesis uses the multilingual model.
    // Caller-supplied language='es' upgrades the model id automatically;
    // English falls back to the constructor default (turbo).
    const modelId =
      input.language === 'es' ? 'eleven_multilingual_v2' : this.modelId;
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: input.text,
          model_id: modelId,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        // Same bound as OpenAiTtsProvider — never hang a voice turn on a
        // stalled vendor.
        signal: AbortSignal.timeout(TTS_SYNTH_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ElevenLabs TTS error (${res.status}): ${body.slice(0, 200)}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return {
      audio: buffer,
      contentType: 'audio/mpeg',
      provider: 'elevenlabs',
    };
  }

  synthesizeStream(input: TtsSynthesizeStreamInput): AsyncIterable<TtsStreamChunk> {
    const modelId =
      input.language === 'es' ? 'eleven_multilingual_v2' : this.modelId;
    const conn = new ElevenLabsStreamConnection({
      apiKey: this.apiKey,
      voiceId: this.voiceId,
      modelId,
    });
    return conn.synthesize(input);
  }
}

/**
 * Factory — selects provider based on environment:
 *   TTS_PROVIDER=elevenlabs → ElevenLabsTtsProvider (lower TTFA)
 *   default                 → OpenAiTtsProvider
 *
 * Returns undefined when no API key is configured so callers can
 * gracefully skip readback rather than throw at wire-up.
 */
export function createTtsProvider(env: {
  TTS_PROVIDER?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  AI_PROVIDER_API_KEY?: string;
}): TtsProvider | undefined {
  if (env.TTS_PROVIDER === 'elevenlabs') {
    if (!env.ELEVENLABS_API_KEY) return undefined;
    // UB-C2 — honor the same ELEVENLABS_VOICE_ID that scripts/render-fillers.ts
    // uses, so pre-rendered filler clips and live TTS speak with ONE voice.
    // (Per-tenant voice selection on the streaming path is a known gap:
    // settings.ttsVoiceEn/Es are Twilio <Say> Polly voices for the Gather
    // path — no per-tenant ElevenLabs voice mapping exists yet.)
    return env.ELEVENLABS_VOICE_ID
      ? new ElevenLabsTtsProvider(env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID)
      : new ElevenLabsTtsProvider(env.ELEVENLABS_API_KEY);
  }
  if (env.AI_PROVIDER_API_KEY) {
    return new OpenAiTtsProvider(env.AI_PROVIDER_API_KEY);
  }
  return undefined;
}

/**
 * P0 boot guard — Twilio Media Streams requires a TtsProvider capable of
 * emitting raw PCM (`synthesizeStream`). `mediastream-adapter.ts` feeds
 * `synthesize()`'s buffered result straight into `streamPcmAsMedia`, which
 * assumes raw PCM16 and does no decoding — a provider that only implements
 * `synthesize()` returns compressed audio (mp3 for OpenAI/ElevenLabs),
 * which streams out as inaudible static with no error surfaced anywhere.
 *
 * Call this once at boot, right after resolving the shared TTS provider,
 * so a misconfigured deploy (e.g. TTS_PROVIDER unset/openai with Media
 * Streams on) fails loud instead of shipping a silent voice outage. Mirrors
 * the fail-fast style used for DATABASE_URL elsewhere in app.ts.
 *
 * No-ops when Media Streams is disabled, and when no provider resolved at
 * all (that's a distinct "no TTS configured" failure mode already surfaced
 * via the /health warnings in app.ts).
 */
export function assertTtsProviderSupportsMediaStreams(input: {
  mediaStreamsEnabled: boolean;
  provider: TtsProvider | undefined;
  /** Raw TTS_PROVIDER env value, for the error message only. */
  ttsProviderEnv?: string;
}): void {
  if (!input.mediaStreamsEnabled) return;
  if (!input.provider) return;
  if (typeof input.provider.synthesizeStream === 'function') return;
  throw new Error(
    `TWILIO_MEDIA_STREAMS_ENABLED=true but the resolved TTS provider ` +
      `(TTS_PROVIDER=${input.ttsProviderEnv ?? 'openai (default)'}) only implements ` +
      `synthesize(), which returns compressed audio (e.g. mp3) unsuitable for ` +
      `Twilio's raw-PCM media path. Media Streams requires a provider that ` +
      `implements synthesizeStream() (raw PCM streaming) — set TTS_PROVIDER=elevenlabs ` +
      `with ELEVENLABS_API_KEY set, or disable TWILIO_MEDIA_STREAMS_ENABLED.`
  );
}

/**
 * Dev/test provider that returns a zero-byte "audio" response so
 * tests can exercise readback plumbing without calling the real API.
 *
 * SAFETY: this MUST NOT be wired in production. If an operator
 * approves a voice-approvable proposal in production and the
 * readback is silent fake audio, they won't know the assistant
 * "said" anything — they'll think their speech wasn't heard and
 * either re-speak (duplicating the mutation on another tenant's
 * pipeline) or abandon the task. The constructor throws in
 * production so this failure mode is loud at wire-up, not silent
 * at runtime.
 */
export class NoopTtsProvider implements TtsProvider {
  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'NoopTtsProvider cannot be used in production — wire a real TtsProvider (e.g., OpenAiTtsProvider) instead.'
      );
    }
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> {
    return {
      audio: Buffer.from(`noop-tts:${input.text.slice(0, 40)}`, 'utf-8'),
      contentType: 'audio/mpeg',
      provider: 'noop-tts',
    };
  }
}
