import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FillerAudioCache } from '../../../../src/ai/agents/customer-calling/filler-audio-cache';

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
