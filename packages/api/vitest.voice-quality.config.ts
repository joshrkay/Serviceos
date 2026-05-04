/**
 * VQ-009 — Vitest config for the Voice Quality v1 corpus runner.
 *
 * Dedicated config for the corpus-runner entry point
 * (`test/voice-quality/voice-quality.test.ts`). Kept separate from the
 * default vitest config so the unit tests in
 * `test/voice-quality/*.test.ts` (schema, observation, runner, etc.)
 * keep running on vitest's default pool while the corpus run uses
 * deterministic 4-way fork parallelism.
 *
 * Why forks (not threads): each worker creates its own InMemory repo
 * bundle and `VITEST_POOL_ID`-derived tenant id namespace. Forks give
 * us hard process-level isolation, which is the simplest way to
 * guarantee no module-level cache (e.g., a shared logger or singleton)
 * leaks state between scripts running in parallel. `minForks ===
 * maxForks === 4` pins the worker count so the per-worker assignment
 * formula in the entry (`i % 4`) is stable; without that pin vitest
 * could elastically scale the pool down on small machines and shift
 * worker IDs.
 *
 * `reporters: ['default', 'json']` + `outputFile.json` emit a machine-
 * readable report that VQ-023's aggregator (Phase 3) consumes to
 * compute pass rates per bucket. Until VQ-023 lands the file is just a
 * by-product of the run.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    root: '.',
    // Only the corpus runner entry — NOT the sibling unit tests in
    // `test/voice-quality/*.test.ts`, which run under the default
    // config.
    include: ['test/voice-quality/**/voice-quality.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 4,
      },
    },
    testTimeout: 30000,
    hookTimeout: 60000,
    globals: false,
    reporters: ['default', 'json'],
    outputFile: { json: './voice-quality-report.json' },
    passWithNoTests: true,
  },
});
