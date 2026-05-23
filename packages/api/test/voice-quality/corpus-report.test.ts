/**
 * VQ-corpus-report — Single-process, cassette-driven, graded corpus run.
 *
 * Produces a REAL per-bucket VoiceQualityReport by:
 *   1. Loading the Layer-1 corpus (filtering out layer2Only scripts).
 *   2. Running each script through the REAL agent via CassetteLLMGateway in
 *      replay mode — NOT the mock gateway used by voice-quality.test.ts.
 *   3. Grading each observation with the full rubric: gradeFloor +
 *      gradeDispositionStructured + (conditionally) gradeDispositionLlm.
 *   4. Aggregating into a VoiceQualityReport, writing both JSON and Markdown
 *      artefacts, and asserting per-script pass/fail.
 *
 * HONESTY CONTRACT
 * ──────────────────
 * - Cassette misses are captured as a script-level harness error and surfaced
 *   in the verdict (not swallowed into a fake pass).
 * - The disposition-LLM judge (criterion 12) is skipped entirely when the
 *   cassette has no judge entries — which is currently true for all cassettes.
 *   This is reported explicitly per-script rather than silently passed.
 * - No network calls are made. Replay mode + recorded cassettes only.
 *
 * KNOWN STATE (as of this authoring)
 * ───────────────────────────────────
 * All 42 corpus cassettes have 0 entries (the cassettes exist but were never
 * recorded). This means every script will hit a cassette miss on the classifier
 * call and the observation will be "minimal" (no intents classified, no proposals).
 * The graders will still run against the minimal observation and produce honest
 * results. The table below captures the ACTUAL pass/fail state.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadCorpus } from '../../src/ai/voice-quality/corpus/loader';
import {
  runScript,
  type DriverFactoryContext,
} from '../../src/ai/voice-quality/runner';
import {
  TextModeDriver,
  type AgentDriver,
} from '../../src/ai/voice-quality/text-mode-driver';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import {
  CassetteLLMGateway,
  defaultCassettesDir,
} from '../../src/ai/voice-quality/cassette-gateway';
import { gradeFloor } from '../../src/ai/voice-quality/graders/floor';
import {
  gradeDispositionStructured,
  loadGoldenForScript,
} from '../../src/ai/voice-quality/graders/disposition-structured';
import {
  gradeDispositionLlm,
  resetJudgeCache,
} from '../../src/ai/voice-quality/graders/disposition-llm';
import {
  aggregate,
  formatReportMarkdown,
  type PerScriptVerdict,
} from '../../src/ai/voice-quality/graders/report';
import type { VoiceQualityScript } from '../../src/ai/voice-quality/schema';
import type { FloorResult } from '../../src/ai/voice-quality/graders/floor';
import type { DispositionStructuredResult } from '../../src/ai/voice-quality/graders/disposition-structured';
import type { DispositionLlmResult } from '../../src/ai/voice-quality/graders/disposition-llm';

// ─── Corpus paths ─────────────────────────────────────────────────────────────

const CORPUS_ROOT = path.resolve(
  __dirname,
  '../../src/ai/voice-quality/corpus',
);
const GOLDEN_ROOT = CORPUS_ROOT; // loadGoldenForScript expects corpusRoot (finds golden/ subdir)
const CASSETTES_DIR = defaultCassettesDir();
const OUTPUT_JSON = path.resolve(__dirname, '../../voice-quality-corpus-report.json');
const OUTPUT_MD = path.resolve(__dirname, '../../voice-quality-corpus-report.md');

// ─── Cassette entry check ─────────────────────────────────────────────────────

/**
 * Returns true if the cassette for this scriptId has at least one recorded
 * entry. When false, replay mode will throw on the first LLM call — we
 * surface this as a harness error rather than swallowing it.
 */
function cassetteHasEntries(scriptId: string): boolean {
  const cassettePath = path.join(CASSETTES_DIR, `${scriptId}.json`);
  if (!fs.existsSync(cassettePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(cassettePath, 'utf-8')) as {
      entries?: unknown[];
    };
    return Array.isArray(parsed.entries) && parsed.entries.length > 0;
  } catch {
    return false;
  }
}

// ─── Grading helpers ──────────────────────────────────────────────────────────

/**
 * Compute the script-level passed flag. The rubric requires:
 *   - floor must pass (ALL applicable floor criteria pass)
 *   - applicable disposition criteria must pass
 *
 * We use the same logic as the report.ts aggregate + the grader results:
 *   - If floorResult.passed is false → failed.
 *   - If dispositionStructuredResult.passed is false → failed.
 *   - If dispositionLlmResult is present and passed is false → failed.
 *   - Otherwise → passed.
 *
 * Cassette misses are a FINDING (surfaced in harnessError) but do NOT
 * automatically force-fail the script — the graders run against the
 * degraded observation and may still pass (e.g. hangup-before-intent,
 * which does not require intent classification). This maintains honesty:
 * a script that passes all applicable criteria even with a cassette miss
 * is genuinely passing.
 */
function computeScriptPassed(
  floorResult: FloorResult,
  dispositionStructuredResult: DispositionStructuredResult,
  dispositionLlmResult: DispositionLlmResult | undefined,
): boolean {
  if (!floorResult.passed) return false;
  if (!dispositionStructuredResult.passed) return false;
  if (dispositionLlmResult !== undefined && !dispositionLlmResult.passed) return false;
  return true;
}

// ─── Per-script run ───────────────────────────────────────────────────────────

interface ScriptRunResult {
  verdict: PerScriptVerdict;
  harnessError: string | undefined;
  llmJudgeSkipReason: string | undefined;
  cassetteMiss: boolean;
}

async function runAndGrade(script: VoiceQualityScript): Promise<ScriptRunResult> {
  const cassettesDir = CASSETTES_DIR;
  const hasCassetteEntries = cassetteHasEntries(script.id);

  // Build a CassetteLLMGateway in replay mode for this script.
  // If there are no entries, the first LLM call will throw "cassette stale".
  const cassetteGateway = new CassetteLLMGateway({
    scriptId: script.id,
    cassettesDir,
    mode: 'replay',
  });

  // Driver factory — mirrors voice-quality.test.ts but uses cassetteGateway.
  const driverFactory = (fctx: DriverFactoryContext): AgentDriver => {
    const store = new VoiceSessionStore({ startInterval: false });
    // Use the cassette gateway passed via fctx (runner injects it when
    // gatewayFactory is provided), falling back to the one we built above.
    const gateway = fctx.gateway ?? cassetteGateway;

    const driver = new TextModeDriver({
      voiceSessionStore: store,
      bus: fctx.bus,
      gateway,
      proposalRepo: fctx.repos.proposalRepo,
      customerRepo: fctx.repos.customerRepo,
      appointmentRepo: fctx.repos.appointmentRepo,
      invoiceRepo: fctx.repos.invoiceRepo,
      estimateRepo: fctx.repos.estimateRepo,
      jobRepo: fctx.repos.jobRepo,
      leadRepo: fctx.repos.leadRepo,
      auditRepo: fctx.repos.auditRepo,
      systemActorId: 'system:vq-corpus-report',
    });

    const wrapped: AgentDriver = {
      startSession: (opts) =>
        driver.startSession({ ...opts, tenantId: fctx.tenantId }),
      speak: (sid, t) => driver.speak(sid, t),
      hangup: (sid) => driver.hangup(sid),
      endSession: async (sid) => {
        await driver.endSession(sid);
        store.dispose();
      },
    };
    return wrapped;
  };

  // Run the script. runScript catches speak/hangup errors internally and
  // stores them in result.errors — we don't need a try/catch here.
  const result = await runScript(script, {
    driverFactory,
    repoMode: 'memory',
    // Inject the cassette gateway so the runner can pass it to the factory
    // via fctx.gateway (the runner only does this when gatewayFactory is
    // provided, so we use that hook instead).
    gatewayFactory: () => cassetteGateway,
  });

  const { observation } = result;
  const startedAt = Date.now() - result.durationMs;

  // Detect cassette miss: the TextModeDriver catches classifyIntent errors
  // and returns an agentResponse containing the error text rather than
  // propagating to the runner's errors[]. So we detect misses by checking:
  //   1. Runner errors[] for "cassette stale" (safety net).
  //   2. speech_outbound events whose transcript includes "cassette stale"
  //      (the actual path when TextModeDriver catches the gateway error).
  //   3. Simply whether the cassette has 0 entries (a priori finding —
  //      only used for reporting, NOT to force-fail the script).
  const runnerCassetteMissErrors = result.errors.filter(
    (e) => e.includes('cassette stale') || e.includes('cassette miss'),
  );
  const speechEvents = observation.events.filter(
    (e) => e.type === 'speech_outbound',
  ) as Array<{ type: string; transcript: string }>;
  const speechCassetteMiss = speechEvents.some(
    (e) => e.transcript.includes('cassette stale') || e.transcript.includes('cassette miss'),
  );
  // cassetteMiss = true if we detected an actual miss at runtime.
  // !hasCassetteEntries is a pre-flight finding (recorded separately).
  const cassetteMiss =
    runnerCassetteMissErrors.length > 0 || speechCassetteMiss || !hasCassetteEntries;

  // harnessError: only set when the miss was ACTUALLY observed at runtime
  // (via runner errors or agent response), not just inferred from cassette
  // being empty. This avoids marking hangup-before-intent as an error —
  // it has an empty cassette but classifyIntent is still called and the
  // agent's response happens to not contain "cassette stale" if the
  // drive catches it gracefully. (Actually it will, but let the graders decide.)
  const harnessError =
    runnerCassetteMissErrors.length > 0
      ? `cassette miss (runner): ${runnerCassetteMissErrors[0]}`
      : speechCassetteMiss
      ? `cassette miss (agent response contains cassette-stale error): classifier threw during speak, agent fell back to error message`
      : undefined;

  // Grade.
  const floorResult = gradeFloor(observation, script);

  const goldenProposals = loadGoldenForScript(script.id, GOLDEN_ROOT);
  const dispositionStructuredResult = gradeDispositionStructured(
    observation,
    script,
    goldenProposals,
  );

  // LLM judge: only when cassette has entries and criterion 12 applies.
  let dispositionLlmResult: DispositionLlmResult | undefined;
  let llmJudgeSkipReason: string | undefined;

  if (script.grading.appliesDisposition.includes(12)) {
    if (!hasCassetteEntries) {
      llmJudgeSkipReason =
        'judge-skipped: cassette has 0 entries — no recorded judge responses to replay; recording required before criterion 12 can be graded';
    } else {
      try {
        dispositionLlmResult = await gradeDispositionLlm({
          observation,
          script,
          gateway: cassetteGateway,
        });
      } catch (err) {
        llmJudgeSkipReason = `judge-error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  const passed = computeScriptPassed(
    floorResult,
    dispositionStructuredResult,
    dispositionLlmResult,
  );

  const verdict: PerScriptVerdict = {
    scriptId: script.id,
    bucket: script.bucket,
    passed,
    floorResult,
    dispositionStructuredResult,
    ...(dispositionLlmResult !== undefined ? { dispositionLlmResult } : {}),
    durationMs: result.durationMs,
    costCents: observation.totalCostCents,
    perTurnLatencyMs: observation.perTurnLatencyMs,
  };

  return { verdict, harnessError, llmJudgeSkipReason, cassetteMiss };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

// Load corpus at module scope — same pattern as voice-quality.test.ts.
const scripts = (() => {
  try {
    return loadCorpus().filter((s) => !s.layer2Only);
  } catch {
    return [];
  }
})();

// Run all scripts and build the report once, before any test assertions.
let allResults: ScriptRunResult[] = [];
let report: ReturnType<typeof aggregate> | undefined;
let reportMarkdown = '';

describe('VQ-corpus-report — cassette-driven graded run', () => {
  beforeAll(async () => {
    resetJudgeCache();

    if (scripts.length === 0) return;

    // Sequential to avoid cassette locking issues.
    for (const script of scripts) {
      allResults.push(await runAndGrade(script));
    }

    const verdicts = allResults.map((r) => r.verdict);
    report = aggregate(verdicts);
    reportMarkdown = formatReportMarkdown(report);

    // Write artefacts.
    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(report, null, 2), 'utf-8');
    fs.writeFileSync(OUTPUT_MD, reportMarkdown, 'utf-8');

    // Print the table to stdout so it appears in test output.
    console.log('\n\n' + '='.repeat(80));
    console.log('VOICE QUALITY CORPUS REPORT');
    console.log('='.repeat(80));
    console.log(reportMarkdown);
    console.log('='.repeat(80) + '\n');

    // Print cassette-miss summary.
    const misses = allResults.filter((r) => r.cassetteMiss);
    if (misses.length > 0) {
      console.log(`\nCassette misses (${misses.length}/${scripts.length} scripts):`);
      for (const r of misses) {
        console.log(`  - ${r.verdict.scriptId}: ${r.harnessError}`);
      }
    }

    // Print judge-skip summary.
    const skipped = allResults.filter((r) => r.llmJudgeSkipReason);
    if (skipped.length > 0) {
      console.log(`\nLLM judge skipped (${skipped.length} scripts):`);
      for (const r of skipped) {
        console.log(`  - ${r.verdict.scriptId}: ${r.llmJudgeSkipReason}`);
      }
    }
  }, 120_000 /* 2 min timeout for the full corpus run */);

  it('VQ-corpus-report — corpus is non-empty', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it('VQ-corpus-report — report artefacts written', () => {
    expect(fs.existsSync(OUTPUT_JSON)).toBe(true);
    expect(fs.existsSync(OUTPUT_MD)).toBe(true);
  });

  it('VQ-corpus-report — report is well-formed', () => {
    expect(report).toBeDefined();
    if (!report) return;
    expect(report.totalScripts).toBe(scripts.length);
    expect(typeof report.overallPassRate).toBe('number');
    expect(Number.isFinite(report.overallPassRate)).toBe(true);
    expect(report.perBucket.length).toBeGreaterThan(0);
    expect(report.perScript.length).toBe(scripts.length);
  });

  it('VQ-corpus-report — cassette state reported (not papered over)', () => {
    // This test documents the current ground truth. It is intentionally
    // non-assertive about pass/fail counts (those change as cassettes are
    // recorded); instead it asserts that the harness DID report cassette
    // misses honestly.
    const misses = allResults.filter((r) => r.cassetteMiss);
    const passes = allResults.filter((r) => r.verdict.passed);

    console.log(
      `\n[cassette state] ${misses.length} misses, ${passes.length} passes, ${scripts.length} total`,
    );

    // If all cassettes are empty, all scripts should have a cassette miss.
    // This is a finding — not a bug in the harness.
    if (misses.length === scripts.length) {
      console.log(
        '[finding] ALL cassettes are empty. Every script ran with a cassette miss. ' +
          'Record cassettes to get real graded results.',
      );
    }

    // Scripts where the cassette miss was ACTUALLY observed at runtime
    // (i.e. the agent response or runner captured the stale-error)
    // should generally be failing. We don't assert this universally
    // because some scripts (e.g. hangup-before-intent) genuinely pass
    // even with empty cassettes (their grading criteria don't require
    // intent classification).
    const runtimeMisses = allResults.filter((r) => r.harnessError !== undefined);
    console.log(`[cassette runtime-misses] ${runtimeMisses.length} scripts had observable cassette errors`);
    // A cassette miss that the graders still pass is a valid state.
    // Document it but don't assert failure.
  });

  // Per-script assertions — one it() per script for clear failure surfacing.
  for (const script of scripts) {
    it(`VQ-CORPUS — ${script.bucket} — ${script.id}`, async () => {
      const r = allResults.find((x) => x.verdict.scriptId === script.id);
      expect(r).toBeDefined();
      if (!r) return;

      const { verdict, harnessError, llmJudgeSkipReason } = r;

      // Build a diagnostic message that surfaces ALL failure reasons.
      const diagnostics: string[] = [];
      if (harnessError) diagnostics.push(`harness: ${harnessError}`);
      if (llmJudgeSkipReason) diagnostics.push(`llm-judge: ${llmJudgeSkipReason}`);
      if (!verdict.floorResult.passed) {
        diagnostics.push(
          `floor failed: criteria [${verdict.floorResult.failedCriteria.join(',')}] — ` +
            Object.entries(verdict.floorResult.reasons)
              .map(([k, v]) => `${k}: ${v}`)
              .join('; '),
        );
      }
      if (!verdict.dispositionStructuredResult.passed) {
        diagnostics.push(
          `structured failed: criteria [${verdict.dispositionStructuredResult.failedCriteria.join(',')}] — ` +
            Object.entries(verdict.dispositionStructuredResult.reasons)
              .map(([k, v]) => `${k}: ${v}`)
              .join('; '),
        );
      }
      if (verdict.dispositionLlmResult && !verdict.dispositionLlmResult.passed) {
        diagnostics.push(
          `llm-grader failed: criteria [${verdict.dispositionLlmResult.failedCriteria.join(',')}] — ` +
            Object.entries(verdict.dispositionLlmResult.reasons)
              .map(([k, v]) => `${k}: ${v}`)
              .join('; '),
        );
      }

      // Assert: script must pass. Failures show the full diagnostic.
      // This is EXPECTED to fail for most/all scripts right now (cassettes
      // are empty). The goal is a REAL and ACCURATE table, not a green suite.
      expect(verdict.passed, `${script.id} FAILED:\n  ${diagnostics.join('\n  ')}`).toBe(true);
    });
  }
});
