/**
 * #1331 — Layer 2 measures FIRST-AUDIBLE latency like production: the
 * media-streams adapter plays a cached filler 250 ms after the caller
 * finishes. Production loads the rendered clips from the fillers directory
 * (`FillerAudioCache`); clips are rendered offline (ElevenLabs) and are not
 * in the repo, so the harness uses any clip on disk and synthesizes the rest
 * once per suite through its own TTS leg. Spanish clips are never
 * synthesized: a missing Spanish clip is silence in production too.
 *
 * Seam: buildLayer2FillerCache (exported).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildLayer2FillerCache } from '../../../src/ai/voice-quality/audio/layer2-fillers';

describe('#1331 — buildLayer2FillerCache', () => {
  it('prefers a rendered clip on disk and synthesizes only the missing English fillers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vq2-fillers-'));
    writeFileSync(join(dir, 'okay.pcm'), Buffer.from('RENDERED-OKAY'));
    const synthesize = vi.fn(async (text: string) => Buffer.from(`SYNTH:${text}`));

    const { cache, source } = await buildLayer2FillerCache({ fillerDir: dir, synthesize });

    expect(cache.get('okay')?.toString()).toBe('RENDERED-OKAY');
    expect(cache.get('one-moment')?.toString()).toBe('SYNTH:One moment.');
    expect(cache.get('es-un-momento')).toBeUndefined();
    expect(synthesize).toHaveBeenCalledTimes(7);
    expect(source).toEqual({ onDisk: 1, synthesized: 7 });
  });
});
