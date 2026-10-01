import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FillerAudioCache,
  fillerSynthesizerFromTts,
  startFillerSynthesis,
} from '../../../../src/ai/agents/customer-calling/filler-audio-cache';
import type { TtsProvider } from '../../../../src/ai/tts/tts-provider';
import { TtsProviderRejectedError } from '../../../../src/ai/tts/tts-errors';

describe('FillerAudioCache', () => {
  it('loads files present on disk and skips missing ones without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-'));
    writeFileSync(join(dir, 'mm-hmm.pcm'), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, 'okay.pcm'), Buffer.from([4, 5, 6]));
    const warnings: unknown[] = [];
    const cache = new FillerAudioCache(dir, { warn: (m, meta) => warnings.push({ m, meta }) });
    cache.load();
    expect(cache.has('mm-hmm')).toBe(true);
    expect(cache.has('okay')).toBe(true);
    expect(cache.has('got-it')).toBe(false);
    expect(warnings.length).toBeGreaterThan(0); // got-it + others missing
  });
});

// #1534 — no clips ship in the image, so the cache synthesizes each missing
// FILLER_LIBRARY clip once (in memory) with the production TTS.
describe('#1534 — FillerAudioCache.fillMissing', () => {
  const quiet = { warn: () => {}, info: () => {} };

  it('synthesizes a missing clip once and get() returns it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-1534-'));
    const cache = new FillerAudioCache(dir, quiet);
    cache.load();
    expect(cache.get('one-moment')).toBeUndefined();

    await cache.fillMissing(async (filler) => Buffer.from(`SYNTH:${filler.text}`));

    expect(cache.get('one-moment')?.toString()).toBe('SYNTH:One moment.');
    expect(cache.get('es-un-momento')?.toString()).toBe('SYNTH:Un momento.');
    expect(cache.size()).toBe(16);
  });

  it('keeps a pre-rendered clip on disk and never synthesizes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-1534-'));
    writeFileSync(join(dir, 'okay.pcm'), Buffer.from('RENDERED-OKAY'));
    const cache = new FillerAudioCache(dir, quiet);
    cache.load();
    const synthesizedTexts: string[] = [];

    await cache.fillMissing(async (filler) => {
      synthesizedTexts.push(filler.text);
      return Buffer.from(`SYNTH:${filler.text}`);
    });

    expect(cache.get('okay')?.toString()).toBe('RENDERED-OKAY');
    expect(synthesizedTexts).not.toContain('Okay.');
    expect(synthesizedTexts).toHaveLength(15);
  });

  it('logs a TTS failure, does not throw, and still fills the other clips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-1534-'));
    const warnings: Array<{ msg: string; meta?: unknown }> = [];
    const cache = new FillerAudioCache(dir, {
      warn: (msg, meta) => warnings.push({ msg, meta }),
      info: () => {},
    });
    cache.load();
    warnings.length = 0;

    await expect(
      cache.fillMissing(async (filler) => {
        if (filler.id === 'got-it') throw new Error('tts 503');
        return Buffer.from(`SYNTH:${filler.text}`);
      }),
    ).resolves.toBeUndefined();

    expect(cache.get('got-it')).toBeUndefined();
    expect(cache.get('okay')?.toString()).toBe('SYNTH:Okay.');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toBe('filler audio synthesis failed');
    expect(warnings[0].meta).toMatchObject({ failedIds: ['got-it'] });
  });

  it('gives up on a clip whose TTS hangs past the timeout, aborts it, and logs what was synthesized', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-1534-'));
    const warnings: Array<{ msg: string; meta?: unknown }> = [];
    const infos: Array<{ msg: string; meta?: unknown }> = [];
    const cache = new FillerAudioCache(dir, {
      warn: (msg, meta) => warnings.push({ msg, meta }),
      info: (msg, meta) => infos.push({ msg, meta }),
    });
    cache.load();
    warnings.length = 0;
    let hungSignalAborted = false;

    await cache.fillMissing(
      (filler, signal) => {
        if (filler.id !== 'let-me-see') return Promise.resolve(Buffer.from(`SYNTH:${filler.text}`));
        signal.addEventListener('abort', () => { hungSignalAborted = true; });
        return new Promise<Buffer>(() => { /* never settles */ });
      },
      { timeoutMs: 30 },
    );

    expect(hungSignalAborted).toBe(true);
    expect(cache.get('let-me-see')).toBeUndefined();
    expect(cache.size()).toBe(15);
    expect(warnings[0].meta).toMatchObject({ failedIds: ['let-me-see'] });
    expect(infos).toEqual([
      { msg: 'filler audio synthesized', meta: expect.objectContaining({ synthesizedCount: 15, failedCount: 1 }) },
    ]);
  });
});

describe('#1534 — startFillerSynthesis (boot entry point)', () => {
  it('with no TTS configured: starts nothing and only the load() "missing" warning is logged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-1534-'));
    const warnings: string[] = [];
    const cache = new FillerAudioCache(dir, { warn: (m) => warnings.push(m), info: () => {} });
    cache.load();

    expect(startFillerSynthesis(cache, undefined)).toBeNull();

    expect(cache.size()).toBe(0);
    expect(warnings).toEqual(['filler audio missing']);
  });

  it('with a streaming TTS: fills the missing clips in the background', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-1534-'));
    const cache = new FillerAudioCache(dir, { warn: () => {}, info: () => {} });
    cache.load();
    const provider: TtsProvider = {
      synthesize: async () => { throw new Error('unused'); },
      synthesizeStream: () => (async function* () {
        yield { pcm: Buffer.from([7, 7]), isFinal: true };
      })(),
    };

    const filling = startFillerSynthesis(cache, provider);
    expect(filling).toBeInstanceOf(Promise);
    await filling;

    expect([...(cache.get('absolutely') ?? [])]).toEqual([7, 7]);
    expect(cache.size()).toBe(16);
  });
});

describe('#1534 — fillerSynthesizerFromTts (the production TTS the adapter speaks with)', () => {
  it('streams the clip as PCM through synthesizeStream with the filler language, concatenating chunks', async () => {
    const calls: Array<{ text: string; language?: string; signal?: AbortSignal }> = [];
    const provider: TtsProvider = {
      synthesize: async () => { throw new Error('mp3 path must not be used for fillers'); },
      synthesizeStream: (input) => {
        calls.push({ text: input.text, language: input.language, signal: input.signal });
        return (async function* () {
          yield { pcm: Buffer.from([1, 2]), isFinal: false };
          yield { pcm: Buffer.from([3, 4]), isFinal: false };
          yield { pcm: Buffer.alloc(0), isFinal: true };
        })();
      },
    };
    const synthesize = fillerSynthesizerFromTts(provider)!;
    const signal = new AbortController().signal;

    const es = await synthesize(
      { id: 'es-un-momento', text: 'Un momento.', approxDurationMs: 480, language: 'es' },
      signal,
    );

    expect([...es]).toEqual([1, 2, 3, 4]);
    expect(calls).toEqual([{ text: 'Un momento.', language: 'es', signal }]);
  });

  it('rejects a clip whose stream produced no audio', async () => {
    const provider: TtsProvider = {
      synthesize: async () => { throw new Error('unused'); },
      synthesizeStream: () => (async function* () {
        yield { pcm: Buffer.alloc(0), isFinal: true };
      })(),
    };
    const synthesize = fillerSynthesizerFromTts(provider)!;

    await expect(
      synthesize({ id: 'okay', text: 'Okay.', approxDurationMs: 260, language: 'en' }, new AbortController().signal),
    ).rejects.toThrow(/no audio/);
  });

  it('returns undefined when no TTS is configured or it cannot stream raw PCM', () => {
    expect(fillerSynthesizerFromTts(undefined)).toBeUndefined();
    expect(
      fillerSynthesizerFromTts({ synthesize: async () => ({ audio: Buffer.alloc(1), contentType: 'audio/mpeg', provider: 'x' }) }),
    ).toBeUndefined();
  });
});

// #1536 — a key without the Text to Speech permission fails every clip; boot
// must say so ONCE, naming the code and the env var, not bury it in 16 errors.
describe('#1536 — startFillerSynthesis when the TTS key cannot synthesize', () => {
  const rejectingProvider = (code: string): TtsProvider => ({
    synthesize: async () => { throw new Error('unused'); },
    synthesizeStream: () => (async function* () {
      throw new TtsProviderRejectedError('elevenlabs', code, `ElevenLabs rejected the speech request (${code})`);
    })(),
  });

  it('logs ONE error naming missing_permissions and ELEVENLABS_API_KEY when every clip is rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-1536-'));
    const errors: Array<{ msg: string; meta?: unknown }> = [];
    const cache = new FillerAudioCache(dir, {
      warn: () => {},
      info: () => {},
      error: (msg, meta) => errors.push({ msg, meta }),
    });
    cache.load();

    await startFillerSynthesis(cache, rejectingProvider('missing_permissions'));

    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toContain('missing_permissions');
    expect(errors[0].msg).toContain('ELEVENLABS_API_KEY');
    expect(errors[0].msg).toContain('Text to Speech permission');
    expect(errors[0].meta).toMatchObject({ code: 'missing_permissions', failedCount: 16 });
  });

  it('does not raise the key error for a non-credential rejection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-1536-'));
    const errors: string[] = [];
    const cache = new FillerAudioCache(dir, { warn: () => {}, info: () => {}, error: (m) => errors.push(m) });
    cache.load();

    await startFillerSynthesis(cache, rejectingProvider('quota_exceeded'));

    expect(errors).toEqual([]);
  });
});
