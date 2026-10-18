import { createHash } from 'node:crypto';

/**
 * S3-1 (plan U4) — content-addressed cache of spoken clips behind
 * `POST /api/voice/tts`.
 *
 * The onboarding option-pair lines are static per trade and voice, so the
 * first owner who hears a line pays the provider and every later owner on the
 * same voice hits the cache. The key is `(provider voice id, sha256(text))`:
 * the RESOLVED provider voice id, never the preset name, so a preset remap can
 * never serve a stale voice; and the trimmed text exactly as the client sent
 * it (the provider normalises on its side via `speakableText`, so the key is
 * what the caller asked for).
 *
 * In-process and bounded (byte budget, least-recently-used eviction), in the
 * spirit of `ai/agents/customer-calling/filler-audio-cache.ts`. Per replica:
 * a miss on another replica is answered by the charged POST, which is the
 * fallback the plan allows. Never throws — a cache failure is a miss.
 */
export interface TtsClip {
  audio: Buffer;
  contentType: string;
}

/** Default budget: 64 MiB, roughly 600+ option-pair lines at mp3 bitrates. */
const DEFAULT_TTS_CLIP_CACHE_BYTES = 64 * 1024 * 1024;

/** sha256 hex of the trimmed text — the second half of the cache key. */
export function hashOf(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex');
}

/**
 * `VOICE_TTS_CLIP_CACHE_BYTES` → byte budget; garbage or non-positive values
 * fall back to the default (a zero budget would silently disable caching).
 */
export function ttsClipCacheBytesFromEnv(env: { VOICE_TTS_CLIP_CACHE_BYTES?: string }): number {
  const parsed = Number(env.VOICE_TTS_CLIP_CACHE_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TTS_CLIP_CACHE_BYTES;
}

export class TtsClipCache {
  /** Insertion order doubles as recency: a hit is re-inserted at the end. */
  private readonly clips = new Map<string, TtsClip>();
  private readonly maxBytes: number;
  private totalBytes = 0;

  constructor(opts: { maxBytes?: number } = {}) {
    this.maxBytes =
      opts.maxBytes !== undefined && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
        ? Math.floor(opts.maxBytes)
        : DEFAULT_TTS_CLIP_CACHE_BYTES;
  }

  get(voiceId: string, hash: string): TtsClip | undefined {
    const key = clipKey(voiceId, hash);
    const clip = this.clips.get(key);
    if (!clip) return undefined;
    // Refresh recency.
    this.clips.delete(key);
    this.clips.set(key, clip);
    return clip;
  }

  has(voiceId: string, hash: string): boolean {
    return this.clips.has(clipKey(voiceId, hash));
  }

  /**
   * Stores a clip, evicting least-recently-used clips until it fits. A clip
   * with no bytes, or more bytes than the whole budget, is not stored.
   */
  set(voiceId: string, hash: string, clip: TtsClip): void {
    const bytes = Buffer.isBuffer(clip?.audio) ? clip.audio.length : 0;
    if (bytes === 0 || bytes > this.maxBytes || typeof clip.contentType !== 'string') return;
    const key = clipKey(voiceId, hash);
    const previous = this.clips.get(key);
    if (previous) {
      this.clips.delete(key);
      this.totalBytes -= previous.audio.length;
    }
    while (this.totalBytes + bytes > this.maxBytes && this.clips.size > 0) {
      const oldest = this.clips.keys().next().value as string;
      const evicted = this.clips.get(oldest)!;
      this.clips.delete(oldest);
      this.totalBytes -= evicted.audio.length;
    }
    this.clips.set(key, { audio: clip.audio, contentType: clip.contentType });
    this.totalBytes += bytes;
  }

  size(): number {
    return this.clips.size;
  }

  bytes(): number {
    return this.totalBytes;
  }
}

function clipKey(voiceId: string, hash: string): string {
  return `${voiceId}:${hash}`;
}
