/**
 * S3-1 (plan U4) — the TTS clip cache behind POST /api/voice/tts.
 *
 * Option-pair lines are static per trade and voice, so a clip is cached by
 * (provider voice id, sha256 of the text the client sent). Seam: the cache's
 * public API only — no provider, no route.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { TtsClipCache, hashOf, ttsClipCacheBytesFromEnv } from '../../../src/ai/tts/clip-cache';

const ADAM = 'pNInz6obpgDQGcFmaJgB';
const RACHEL = '21m00Tcm4TlvDq8ikWAM';

function clip(bytes: number, fill = 'a') {
  return { audio: Buffer.alloc(bytes, fill), contentType: 'audio/mpeg' };
}

describe('S3-1 — TtsClipCache', () => {
  it('round-trips a clip by (voice, hash) and reports has/size', () => {
    const cache = new TtsClipCache();
    const hash = hashOf('Tap one to hear it.');
    expect(cache.has(ADAM, hash)).toBe(false);
    expect(cache.get(ADAM, hash)).toBeUndefined();

    cache.set(ADAM, hash, clip(12));

    expect(cache.has(ADAM, hash)).toBe(true);
    expect(cache.get(ADAM, hash)).toEqual({ audio: Buffer.alloc(12, 'a'), contentType: 'audio/mpeg' });
    expect(cache.size()).toBe(1);
  });

  it('keys differ by voice for the same text, and by text for the same voice', () => {
    const cache = new TtsClipCache();
    const hash = hashOf('Tap one to hear it.');
    cache.set(ADAM, hash, clip(3, 'x'));

    // Same text, another voice: a miss, never Adam's bytes in Rachel's voice.
    expect(cache.get(RACHEL, hash)).toBeUndefined();
    // Same voice, another text: a miss.
    expect(cache.get(ADAM, hashOf('Pick the one that sounds right.'))).toBeUndefined();

    cache.set(RACHEL, hash, clip(3, 'y'));
    expect(cache.get(ADAM, hash)!.audio.toString()).toBe('xxx');
    expect(cache.get(RACHEL, hash)!.audio.toString()).toBe('yyy');
    expect(cache.size()).toBe(2);
  });

  it('hashOf is the sha256 hex of the trimmed text', () => {
    const expected = createHash('sha256').update('Tap one to hear it.', 'utf8').digest('hex');
    expect(hashOf('Tap one to hear it.')).toBe(expected);
    expect(hashOf('  Tap one to hear it.\n')).toBe(expected);
    expect(hashOf('Tap one to hear it.')).toMatch(/^[0-9a-f]{64}$/);
    // Content inside the text still counts — only the ends are trimmed.
    expect(hashOf('Tap one  to hear it.')).not.toBe(expected);
  });

  it('evicts the least-recently-used clip first when the byte budget is exceeded', () => {
    const cache = new TtsClipCache({ maxBytes: 30 });
    const a = hashOf('a');
    const b = hashOf('b');
    const c = hashOf('c');
    cache.set(ADAM, a, clip(10));
    cache.set(ADAM, b, clip(10));
    cache.set(ADAM, c, clip(10));
    expect(cache.bytes()).toBe(30);

    // Touch `a` so `b` becomes the least recently used.
    expect(cache.get(ADAM, a)).toBeDefined();

    cache.set(ADAM, hashOf('d'), clip(10));

    expect(cache.has(ADAM, b)).toBe(false);
    expect(cache.has(ADAM, a)).toBe(true);
    expect(cache.has(ADAM, c)).toBe(true);
    expect(cache.has(ADAM, hashOf('d'))).toBe(true);
    expect(cache.size()).toBe(3);
    expect(cache.bytes()).toBe(30);
  });

  it('replacing a clip under the same key accounts its bytes once', () => {
    const cache = new TtsClipCache({ maxBytes: 100 });
    const hash = hashOf('a');
    cache.set(ADAM, hash, clip(10));
    cache.set(ADAM, hash, clip(20));
    expect(cache.size()).toBe(1);
    expect(cache.bytes()).toBe(20);
  });

  it('does not store a zero-byte clip or one larger than the budget', () => {
    const cache = new TtsClipCache({ maxBytes: 16 });
    cache.set(ADAM, hashOf('empty'), clip(0));
    cache.set(ADAM, hashOf('huge'), clip(17));

    expect(cache.has(ADAM, hashOf('empty'))).toBe(false);
    expect(cache.has(ADAM, hashOf('huge'))).toBe(false);
    expect(cache.size()).toBe(0);
    expect(cache.bytes()).toBe(0);

    // A clip that exactly fits is stored.
    cache.set(ADAM, hashOf('fits'), clip(16));
    expect(cache.has(ADAM, hashOf('fits'))).toBe(true);
  });

  it('never throws on a malformed call: a bad clip is a miss', () => {
    const cache = new TtsClipCache();
    const hash = hashOf('a');
    expect(() =>
      cache.set(ADAM, hash, { audio: undefined as unknown as Buffer, contentType: 'audio/mpeg' }),
    ).not.toThrow();
    expect(cache.get(ADAM, hash)).toBeUndefined();
  });

  it('reads the byte budget from VOICE_TTS_CLIP_CACHE_BYTES, defaulting to 64 MiB', () => {
    expect(ttsClipCacheBytesFromEnv({})).toBe(64 * 1024 * 1024);
    expect(ttsClipCacheBytesFromEnv({ VOICE_TTS_CLIP_CACHE_BYTES: '1048576' })).toBe(1048576);
    // Garbage or non-positive values fall back to the default, never to 0.
    expect(ttsClipCacheBytesFromEnv({ VOICE_TTS_CLIP_CACHE_BYTES: 'lots' })).toBe(64 * 1024 * 1024);
    expect(ttsClipCacheBytesFromEnv({ VOICE_TTS_CLIP_CACHE_BYTES: '0' })).toBe(64 * 1024 * 1024);
  });
});
