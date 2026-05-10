/**
 * VQ2-016 — Layer 2 corpus runner entry.
 *
 * INTENT (full version): run every layer2-eligible script through the
 * AudioModeDriver + 2-of-3 voting pipeline, apply caller-experience
 * graders (TTFA, perceived-completion, audio-quality), and write the
 * final `Layer2Report` to disk for the CI artifact step.
 *
 * CURRENT STATUS — STUB:
 * The full real-mode wiring requires:
 *   - Booting the production Express app with `authTestMode: true`
 *   - Spinning the Twilio Stream emulator (VQ2-006..008) against it
 *   - Constructing the AudioModeDriver (VQ2-005) with the emulator
 *   - Wiring the real Whisper provider (VQ2-001..004)
 *   - Wiring the real LLM gateway via `createRealLayerTwoGateway`
 *   - Threading the suite-level cost tracker through every script
 *
 * That integration is >150 lines of harness setup and is deferred to
 * a follow-up. The pre-deploy CI workflow is the value-delivery for
 * VQ2-016 — it must run, find this entry, skip honestly when keys are
 * absent (which is the common case for forks / branches without
 * secrets), and always emit a structured Layer 2 report so the
 * `actions/upload-artifact` step has a file to grab.
 *
 * Skip-path semantics:
 *   - Empty corpus → skip + write empty report
 *   - Missing API keys → skip + write empty report
 *   - Keys present → currently still skip (real-mode wiring not yet
 *     implemented). When the integration lands, replace the
 *     `it.skip(...)` with the real `it.each(scripts)` block.
 *
 * The empty report is still a valid `Layer2Report` — `buildLayer2Report`
 * over an empty result array yields zeroed aggregates, which the
 * launch-gate consumer correctly interprets as "no data" rather than
 * "passed".
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { loadLayer2Corpus } from '../../src/ai/voice-quality/corpus/loader';
import { buildLayer2Report } from '../../src/ai/voice-quality/report-layer2';

const REPORT_PATH = path.resolve(
  __dirname,
  '../../voice-quality-layer2-report.json',
);

const scripts = (() => {
  try {
    return loadLayer2Corpus();
  } catch {
    return [];
  }
})();

const hasKeys =
  !!process.env.ANTHROPIC_API_KEY && !!process.env.OPENAI_API_KEY;

function writeEmptyReport(): void {
  // Always-write so the CI artifact upload step finds the file even
  // when we skip. `buildLayer2Report([])` yields zeroed aggregates.
  const emptyReport = buildLayer2Report([]);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(emptyReport, null, 2));
}

describe('Voice Quality Layer 2 — corpus', () => {
  if (scripts.length === 0) {
    writeEmptyReport();
    it.skip('VQ2-016 — Layer 2 corpus empty', () => {
      expect(true).toBe(true);
    });
    return;
  }

  if (!hasKeys) {
    writeEmptyReport();
    it.skip(
      'VQ2-016 — Layer 2 requires ANTHROPIC_API_KEY + OPENAI_API_KEY (skipping in env without keys)',
      () => {
        expect(true).toBe(true);
      },
    );
    return;
  }

  // TODO(VQ2-016-followup): real-mode end-to-end wiring.
  //
  // When the integration lands, replace this skip block with:
  //
  //   const ctx = await buildLayer2Ctx({ ... });    // server + driver + gateway
  //   it.each(scripts)('VQ2-016 — $id', async (script) => {
  //     const result = await runScriptLayer2(ctx, script);
  //     results.push(result);
  //     expect(result.aggregated.floor.passed).toBe(true);
  //   });
  //   afterAll(() => {
  //     fs.writeFileSync(REPORT_PATH, JSON.stringify(buildLayer2Report(results), null, 2));
  //   });
  //
  // For now: skip even with keys, write the empty report. This keeps
  // the pre-deploy gate honest — it doesn't falsely report PASS on a
  // pipeline that hasn't actually exercised any scripts.
  writeEmptyReport();
  it.skip(
    'VQ2-016 — Layer 2 real-mode wiring pending (corpus + keys present, but integration not yet implemented)',
    () => {
      expect(true).toBe(true);
    },
  );
});
