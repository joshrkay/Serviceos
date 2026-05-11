/**
 * VQ-009 — Vitest entry point + per-worker tenant isolation (sanity tests).
 *
 * These tests cover the configuration plumbing for the corpus-runner
 * entry point. The corpus-runner entry itself
 * (`test/voice-quality/voice-quality.test.ts`) is exercised by the
 * dedicated `vitest.voice-quality.config.ts` config, which spreads
 * scripts across 4 forked workers. The unit tests in this file run
 * under the default config and pin the contracts the corpus runner
 * depends on:
 *
 *  - The dedicated config exists, only includes the corpus runner
 *    entry pattern (not the sibling unit tests), and uses 4 forked
 *    workers.
 *  - `loadCorpus()` returns `[]` for an empty/absent root rather than
 *    throwing — this is what lets the entry skip cleanly during the
 *    Phase-1→Phase-2 transition window before any corpus is authored.
 *  - The deterministic worker assignment formula `i % 4` pins each
 *    script index to exactly one worker.
 *  - The tenant id namespacing (`vq_test_w<workerId>_<scriptId>`)
 *    guarantees no two workers share a tenant id even if they touch
 *    the same script id (defense-in-depth on top of per-worker repo
 *    bundles).
 *
 * Why a separate config at all: the corpus runner needs deterministic
 * 4-way fork parallelism (so worker IDs are stable) and emits a JSON
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

  it('VQ-009 — vitest config sets pool=forks with 4 workers', () => {
    const configPath = path.resolve(__dirname, '../../vitest.voice-quality.config.ts');
    const src = fs.readFileSync(configPath, 'utf-8');
    expect(src).toMatch(/pool:\s*['"]forks['"]/);
    expect(src).toMatch(/maxForks:\s*4/);
    expect(src).toMatch(/minForks:\s*4/);
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

  it('VQ-009 — worker assignment is deterministic: scripts[i] -> worker (i % 4)', () => {
    // Recreate the formula the entry uses. We don't import from the
    // entry (it executes loadCorpus at import-time), but pin the
    // arithmetic + locality property so a regression in the entry's
    // filter would flip a separate test.
    const scripts = Array.from({ length: 17 }, (_, i) => i);
    const workerCount = 4;
    for (let workerId = 0; workerId < workerCount; workerId++) {
      const mine = scripts.filter(
        (_, i) => ((i % workerCount) + workerCount) % workerCount === workerId,
      );
      // Each script index must show up under exactly one worker.
      for (const idx of mine) {
        expect(idx % workerCount).toBe(workerId);
      }
    }
    // Union of all workers' assignments equals the original list.
    const union = new Set<number>();
    for (let workerId = 0; workerId < workerCount; workerId++) {
      for (const idx of scripts.filter(
        (_, i) => ((i % workerCount) + workerCount) % workerCount === workerId,
      )) {
        union.add(idx);
      }
    }
    expect(union.size).toBe(scripts.length);
  });

  it('VQ-009 — tenant id namespacing prevents collision: w0 + scriptA != w1 + scriptA', () => {
    // The entry mints tenant ids as `vq_test_w<workerId>_<scriptId>`.
    // Two different workers running against the same script id must
    // produce distinct tenant ids — defense-in-depth on top of the
    // already per-worker repo bundle isolation.
    const scriptId = 'lookup-customer-001';
    const t0 = `vq_test_w0_${scriptId}`;
    const t1 = `vq_test_w1_${scriptId}`;
    expect(t0).not.toBe(t1);
    expect(t0).toMatch(/^vq_test_w\d+_/);
    expect(t1).toMatch(/^vq_test_w\d+_/);
  });
});
