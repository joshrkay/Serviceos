/**
 * #1331 — a buffered synth honors the caller's AbortSignal, so the
 * media-streams adapter's per-attempt deadline actually cancels the stalled
 * HTTP request instead of leaving it open for the provider's 30 s timeout.
 * Seam: the public TtsProvider.synthesize (global fetch stubbed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiTtsProvider, ElevenLabsTtsProvider } from '../../../src/ai/tts/tts-provider';

/** fetch that hangs until its signal aborts, then rejects like undici does. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('#1331 — REST TTS synth honors the caller abort', () => {
  it.each([
    ['OpenAI', () => new OpenAiTtsProvider('sk-test')],
    ['ElevenLabs', () => new ElevenLabsTtsProvider('el-test')],
  ])('%s: aborting the caller signal rejects the pending synth promptly', async (_name, make) => {
    vi.stubGlobal('fetch', hangingFetch());
    const caller = new AbortController();
    const pending = make().synthesize({ text: 'Booked for Tuesday.', signal: caller.signal });
    setTimeout(() => caller.abort(), 20);
    const started = Date.now();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
