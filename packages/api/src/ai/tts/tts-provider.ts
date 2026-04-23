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

export interface TtsProvider {
  synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult>;
}

/**
 * OpenAI tts-1 implementation. Uses the same AI_PROVIDER_API_KEY as
 * the rest of the gateway, so no new credentials are required. If
 * you want a different voice service, swap this class at the
 * `createTtsProvider` factory in app.ts.
 */
export class OpenAiTtsProvider implements TtsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'tts-1'
  ) {
    if (!apiKey) throw new Error('OpenAiTtsProvider requires AI_PROVIDER_API_KEY');
  }

  async synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult> {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: input.text,
        voice: input.voice ?? 'alloy',
        response_format: 'mp3',
      }),
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
