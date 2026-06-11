/**
 * VQ-009 — Voice Quality v1 (Layer 1) corpus runner entry.
 *
 * Runs each script through `runScript`, grades with floor + disposition
 * graders, writes per-script verdict shards, and relies on global
 * teardown to merge into `voice-quality-report.json` (VQ-024).
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { loadCorpus } from '../../src/ai/voice-quality/corpus/loader';
import { runScript } from '../../src/ai/voice-quality/runner';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import { gradeLayer1Script } from '../../src/ai/voice-quality/grade-layer1';
import { buildCassetteGatewayForScript } from './voice-quality-driver-factory';
import { makeVoiceQualityDriverFactory } from './voice-quality-driver-factory';
const VOICE_QUALITY_VERDICTS_DIR = path.resolve(
  __dirname,
  '../../.voice-quality-verdicts',
);

const scripts = (() => {
  try {
    return loadCorpus().filter((s) => !s.layer2Only);
  } catch {
    return [];
  }
})();

// Run the full Layer 1 corpus in each vitest process. (Fork sharding by
// worker id is disabled so `merge-voice-quality-report` always sees all
// script verdict shards — CI uses maxForks: 1 for deterministic merges.)
const myScripts = scripts;

function writeVerdictShard(verdict: Awaited<ReturnType<typeof gradeLayer1Script>>): void {
  fs.mkdirSync(VOICE_QUALITY_VERDICTS_DIR, { recursive: true });
  const file = path.join(VOICE_QUALITY_VERDICTS_DIR, `${verdict.scriptId}.json`);
  fs.writeFileSync(file, JSON.stringify(verdict, null, 2));
}

describe('Voice Quality v1 (Layer 1) — corpus', () => {
  if (scripts.length === 0) {
    it.skip('VQ-009 — corpus empty; awaiting Phase 2 authoring', () => {
      expect(true).toBe(true);
    });
    return;
  }

  for (const script of myScripts) {
    it(`VQ-CORPUS — ${script.bucket} — ${script.id}`, async () => {
      const tenantId = `vq_test_${script.id}`;
      const driverFactory = makeVoiceQualityDriverFactory(script);
      const gatewayFactory = () => buildCassetteGatewayForScript(script);

      const result = await runScript(script, {
        driverFactory,
        repoMode: 'memory',
        gatewayFactory,
      });

      const { gateway: judgeGateway } = createMockLLMGateway(
        JSON.stringify({
          answerMeaningMatches: true,
          softSlotsReasonable: true,
          rationale: 'vq corpus judge pass',
        }),
      );
      const verdict = await gradeLayer1Script({
        observation: result.observation,
        script,
        gateway: judgeGateway,
        durationMs: result.durationMs,
      });

      writeVerdictShard(verdict);

      expect(result.errors).toEqual([]);
      expect(result.observation.scriptId).toBe(script.id);
      expect(typeof verdict.passed).toBe('boolean');
      expect(tenantId).toMatch(/^vq_test_/);
    });
  }
});
