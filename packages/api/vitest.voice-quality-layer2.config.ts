/**
 * VQ2-016 — Vitest config for the Voice Quality v1 Layer 2 corpus runner.
 *
 * Distinct from `vitest.voice-quality.config.ts` (Layer 1) because:
 *   - Layer 2 uses the real LLM gateway + real Whisper + AudioModeDriver,
 *     so each script is an order of magnitude slower than Layer 1.
 *   - Per-script timeout bumped to 60s; a single script with real audio
 *     can take 30s+ once you include TTS synthesis, telephony emulator
 *     framing, Whisper transcription, and 3-way voting.
 *   - Pool is pinned to 1 fork. Voting is inherently sequential per
 *     script (3 votes, gateway-bound) so parallel forks would just
 *     multiply concurrent API calls without improving wall-time. Plus
 *     the suite-level cost cap is enforced by a singleton tracker that
 *     would not see across forks.
 *
 * `outputFile.json` is the vitest-native report (test pass/fail
 * structure). The Layer 2 harness ALSO writes its own structured report
 * to `voice-quality-layer2-report.json` via `buildLayer2Report` — that
 * is the one CI uploads as the `voice-quality-layer2-report` artifact
 * and the launch-gate consumes for verdict logic. Keep the filenames
 * distinct so artifact upload paths and the harness output don't
 * collide.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    root: '.',
    // Only the Layer 2 corpus runner entry — NOT the unit tests in
    // `test/voice-quality/*.test.ts` (those run under the default
    // config) and NOT the Layer 1 corpus entry (that uses
    // `vitest.voice-quality.config.ts`).
    include: ['test/voice-quality/**/voice-quality.layer2.test.ts'],
    // Sequential: voting is inherently sequential per script; no benefit from
    // parallel forks at this layer. Vitest 4 removed `poolOptions`;
    // `maxWorkers`/`minWorkers: 1` + `isolate: false` reproduce the old
    // single-fork (`poolOptions.forks.maxForks/minForks`) behaviour.
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    isolate: false,
    testTimeout: 60_000,    // single script can take 30s+ with real audio
    hookTimeout: 120_000,
    globals: false,
    reporters: ['default', 'json'],
    // Distinct from the harness's structured report
    // (voice-quality-layer2-report.json). This is just the vitest-
    // native test-run JSON; the launch-gate consumer wants the harness
    // file, not this one.
    outputFile: { json: './voice-quality-layer2-vitest-report.json' },
    passWithNoTests: true,
  },
});
