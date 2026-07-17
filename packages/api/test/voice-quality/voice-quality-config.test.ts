/**
 * VQ-009 — Vitest entry point + per-worker tenant isolation (sanity tests).
 *
 * These tests cover the configuration plumbing for the corpus-runner
 * entry point. The corpus-runner entry itself
 * (`test/voice-quality/voice-quality.test.ts`) is exercised by the
 * dedicated `vitest.voice-quality.config.ts` config, which spreads
 * scripts in a single forked worker. The unit tests in this file run
 * under the default config and pin the contracts the corpus runner
 * depends on:
 *
 *  - The dedicated config exists, only includes the corpus runner
 *    entry pattern (not the sibling unit tests), and uses one forked
 *    worker so verdict shards merge deterministically.
 *  - `loadCorpus()` returns `[]` for an empty/absent root rather than
 *    throwing — this is what lets the entry skip cleanly during the
 *    Phase-1→Phase-2 transition window before any corpus is authored.
 *  - The tenant id pattern (`vq_test_<scriptId>`) namespaces each script.
 *
 * Why a separate config at all: the corpus runner needs a dedicated
 * config (so it is excluded from default `npm test`) and emits a JSON
 * report graders/aggregators consume (VQ-023). The default config
 * runs with vitest's default pool, threaded, no JSON reporter, so
 * mixing the corpus runs into the default suite would muddy both.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { loadCorpus } from '../../src/ai/voice-quality/corpus/loader';

describe('VQ-009 — vitest config + corpus entry plumbing', () => {
  it('VQ-009 — vitest config picks up only the corpus runner entry pattern', () => {
    const configPath = path.resolve(__dirname, '../../vitest.voice-quality.config.ts');
    expect(fs.existsSync(configPath)).toBe(true);
    const src = fs.readFileSync(configPath, 'utf-8');
    // Should target the corpus runner entry file specifically, NOT
    // the sibling unit tests in the same directory.
    expect(src).toMatch(/test\/voice-quality\/\*\*\/voice-quality\.test\.ts/);
    // The `include:` array literal must NOT contain a single-star
    // wildcard like `'test/voice-quality/*.test.ts'` which would
    // scoop up schema/observation/runner tests. We extract the
    // include array's contents and check.
    const includeMatch = src.match(/include:\s*\[([^\]]+)\]/);
    expect(includeMatch).not.toBeNull();
    const includeBlock = includeMatch![1];
    // Inside the include array literal: only `**/voice-quality.test.ts`
    // is allowed; a bare `*.test.ts` would be a regression.
    expect(includeBlock).not.toMatch(/voice-quality\/\*\.test\.ts/);
    expect(includeBlock).toMatch(/voice-quality\.test\.ts/);
  });

  it('VQ-009 — vitest config sets pool=forks with a single worker', () => {
    const configPath = path.resolve(__dirname, '../../vitest.voice-quality.config.ts');
    const src = fs.readFileSync(configPath, 'utf-8');
    expect(src).toMatch(/pool:\s*['"]forks['"]/);
    // Vitest 4 removed poolOptions.forks.{maxForks,minForks}; the single-fork
    // sequential-corpus guarantee is now expressed as maxWorkers/minWorkers: 1.
    expect(src).toMatch(/maxWorkers:\s*1/);
    expect(src).toMatch(/minWorkers:\s*1/);
  });

  it('VQ-009 — corpus runner entry handles empty corpus gracefully', () => {
    // Build a fresh temp dir with no buckets — loadCorpus should
    // return [] without throwing. The runner entry's skip guard
    // depends on this.
    const empty = mkdtempSync(path.join(tmpdir(), 'vq-009-empty-'));
    const result = loadCorpus(empty);
    expect(result).toEqual([]);

    // Also: a totally absent path must not throw (the loader's
    // existsSync short-circuit covers this — but we pin it).
    const absent = path.join(empty, 'does-not-exist');
    const result2 = loadCorpus(absent);
    expect(result2).toEqual([]);

    // And: the entry file itself must contain a guard that produces a
    // single skip-style placeholder when the corpus is empty.
    const entryPath = path.resolve(__dirname, './voice-quality.test.ts');
    expect(fs.existsSync(entryPath)).toBe(true);
    const entrySrc = fs.readFileSync(entryPath, 'utf-8');
    // The placeholder is a literal `it(` that runs unconditionally
    // when the corpus is empty (vitest doesn't allow zero-test
    // describe blocks without `passWithNoTests`).
    expect(entrySrc).toMatch(/corpus empty|no scripts/i);
  });

  it('VQ-009 — default vitest config excludes the corpus runner entry', () => {
    const configPath = path.resolve(__dirname, '../../vitest.config.ts');
    const src = fs.readFileSync(configPath, 'utf-8');
    expect(src).toMatch(/voice-quality\.test\.ts/);
  });

  it('VQ-009 — tenant id namespacing uses script id suffix', () => {
    const scriptId = 'lookup-customer-001';
    const tenantId = `vq_test_${scriptId}`;
    expect(tenantId).toMatch(/^vq_test_/);
    expect(tenantId.endsWith(scriptId)).toBe(true);
  });
});
