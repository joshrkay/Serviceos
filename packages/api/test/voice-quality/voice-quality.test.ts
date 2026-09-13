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

/**
 * #869 acceptance condition, machine-checked.
 *
 * "No script ends with a refused lookup in its observation errors." A refusal
 * means the script is running as the WRONG PERSONA — asking an owner question
 * from a customer's line — which is exactly the leak #866 closed and the corpus
 * used to assert. It cannot be left to review: the graders never read
 * `observation.errors`, and the Layer 1 judge is a canned pass, so three scripts
 * refused for a whole commit while the suite stayed 73/73 green.
 *
 * Deliberately ONLY `refused`. Other failed-lookup reasons are honest outcomes a
 * script may legitimately pin — `unidentified_caller` (the caller matched a lead,
 * not a customer) is one the corpus relies on today — and folding them in here
 * would make this assertion mean "no lookup ever failed", which is a different,
 * wrong claim.
 *
 * Accumulated across the per-script tests and asserted once at the end; the
 * corpus lane is a single sequential fork (see vitest.voice-quality.config.ts),
 * so declaration order is run order. Filtering the run to one script with `-t`
 * naturally narrows what this sees — it is a full-corpus gate, as CI runs it.
 */
const refusedLookups: { scriptId: string; intent: string }[] = [];

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

      for (const err of result.observation.errors) {
        if (err.message === 'refused') {
          refusedLookups.push({ scriptId: script.id, intent: err.event });
        }
      }

      expect(result.errors).toEqual([]);
      expect(result.observation.scriptId).toBe(script.id);
      // Each scenario must actually PASS its rubric — a red scenario makes
      // vitest itself red (the merge/launch-gate is a second, aggregate
      // guard, but the per-script test is the first line of defense). The
      // message names the failing criteria + reasons so triage is one read.
      const reasonParts: string[] = [];
      if (verdict.floorResult.failedCriteria.length > 0) {
        reasonParts.push(
          `floor=[${verdict.floorResult.failedCriteria.join(',')}] ${JSON.stringify(verdict.floorResult.reasons)}`,
        );
      }
      if (verdict.dispositionStructuredResult.failedCriteria.length > 0) {
        reasonParts.push(
          `structured=[${verdict.dispositionStructuredResult.failedCriteria.join(',')}] ${JSON.stringify(verdict.dispositionStructuredResult.reasons)}`,
        );
      }
      if (
        verdict.dispositionLlmResult &&
        verdict.dispositionLlmResult.failedCriteria.length > 0
      ) {
        reasonParts.push(
          `llm=[${verdict.dispositionLlmResult.failedCriteria.join(',')}] ${JSON.stringify(verdict.dispositionLlmResult.reasons)}`,
        );
      }
      expect(
        verdict.passed,
        `Voice-quality scenario '${script.id}' (${script.bucket}) failed its rubric: ${
          reasonParts.join('; ') || 'no criteria detail captured'
        }`,
      ).toBe(true);
      expect(tenantId).toMatch(/^vq_test_/);
    });
  }

  it('#869 — no Layer 1 script ends with a REFUSED lookup', () => {
    expect(
      refusedLookups.map((r) => `${r.scriptId} \u2192 ${r.intent}`),
      'A corpus script was REFUSED by the shared lookup dispatch, which means it ' +
        'is asking as the wrong persona: an owner-grade question from a line the ' +
        'harness resolved to no actor (or to a non-owner). Fix the SCRIPT, not the ' +
        'dispatch \u2014 set `callerIsOwner: true` if the caller really is the owner ' +
        'line, or change the question. See #869 decision 4.',
    ).toEqual([]);
  });
});
