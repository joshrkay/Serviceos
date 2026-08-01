/**
 * VQ-009 — Vitest config for the Voice Quality v1 corpus runner.
 *
 * Dedicated config for the corpus-runner entry point
 * (`test/voice-quality/voice-quality.test.ts`). Kept separate from the
 * default vitest config so the unit tests in
 * `test/voice-quality/*.test.ts` (schema, observation, runner, etc.)
 * keep running on vitest's default pool while the corpus run uses
 * a single fork so all verdict shards merge in one pass.
 *
 * Why forks (not threads): each run gets its own InMemory repo bundle.
 * `minForks === maxForks === 1` keeps the corpus sequential in one
 * process so `merge-voice-quality-report.ts` sees every script shard.
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
    // Single fork so all 40 script verdict shards land in one merge pass.
    // Vitest 4 removed `poolOptions`; `maxWorkers`/`minWorkers: 1` pin one fork
    // (the old `poolOptions.forks.maxForks/minForks`). Default per-file
    // isolation is kept — singleFork never disabled module isolation, and
    // sequentiality comes from the single worker, not from sharing a registry.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 60000,
    globals: false,
    reporters: ['default', 'json'],
    // VQ-023 aggregator writes `voice-quality-report.json` in globalTeardown.
    outputFile: { json: './voice-quality-vitest.json' },
    passWithNoTests: true,
  },
});
