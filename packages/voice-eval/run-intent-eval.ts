#!/usr/bin/env npx tsx
/**
 * run-intent-eval.ts — intent-classification accuracy on a held-out test split.
 *
 *   npx tsx packages/voice-eval/run-intent-eval.ts                    # offline baseline
 *   npx tsx packages/voice-eval/run-intent-eval.ts --live             # production model
 *   npx tsx packages/voice-eval/run-intent-eval.ts --live --gate      # enforce 92% target
 *   npx tsx packages/voice-eval/run-intent-eval.ts --live --max-utterances 200
 *
 * Modes:
 *   OFFLINE (default): the rule baseline (baseline-classifier.ts). Always runs;
 *     reports accuracy + per-intent confusion. Enforces only a low regression
 *     floor (OFFLINE_FLOOR) unless --gate is given.
 *   LIVE (--live): routes utterances through the PRODUCTION classifier
 *     (classifyIntent) behind the Layer-2 real gateway. Requires
 *     ANTHROPIC_API_KEY (or AI_PROVIDER_API_KEY). Enforces LIVE_INTENT_TARGET
 *     (0.92) when --gate is given. Fails fast (exit 2) when no key is present —
 *     never silently falls back to offline.
 *
 * Cost controls (live only):
 *   --max-utterances N   deterministic sub-sample of the held-out split.
 *   VOICE_EVAL_COST_CAP_CENTS (default 500 = $5): pre-flight projected cost is
 *     checked against this cap; the run aborts (exit 3) before spending a cent
 *     if the projection exceeds it.
 *
 * Baseline regression gate (#839, both modes — see baseline.ts):
 *   --baseline <file>          fail (exit 1) if accuracy / macro-F1 dropped past
 *                              the baseline's tolerance or the golden set changed;
 *                              exit 4 if the baseline is an unrecorded placeholder.
 *   --record-baseline <file>   write this run's metrics as the new baseline.
 *
 * Held-out split: deterministic 20% by stable hash of the utterance, so the test
 * set is stable across runs and independent of row order.
 */
import { classificationReport, type ClassReport } from './metrics';
import { classifyBaseline } from './baseline-classifier';
import { intentGoldenKey, loadIntentTestSplit as loadTestSplit, type IntentGoldRow } from './corpus';
import {
  LIVE_BASELINE_TOLERANCE,
  OFFLINE_BASELINE_TOLERANCE,
  applyBaselineGate,
  fingerprintGoldenSet,
  parseBaselineArgs,
  type EvalMode,
} from './baseline';
import {
  ActualCostCapExceededError,
  assertActualCostWithinCap,
  LIVE_INTENT_TARGET,
  SYNTHETIC_TENANT_ID,
  checkCostCap,
  evaluateGate,
  parseMaxUtterances,
  resolveCostCapCents,
  resolveLiveApiKey,
  runLiveIntentEval,
  sampleDeterministic,
} from './live-support';

const OFFLINE_FLOOR = 0.50; // regression guard for the rule baseline on this data

const RECORD_COMMANDS: Record<EvalMode, string> = {
  offline: 'npx tsx packages/voice-eval/run-intent-eval.ts --record-baseline packages/voice-eval/baselines/intent-offline.json',
  live: 'ANTHROPIC_API_KEY=... VOICE_EVAL_COST_CAP_CENTS=1500 npx tsx packages/voice-eval/run-intent-eval.ts --live --max-utterances 200 --record-baseline packages/voice-eval/baselines/intent-live.json',
};

/**
 * Compare/record against a baseline when asked. Returns the exit code the
 * baseline step demands (0 when not requested) after printing its verdict.
 */
function baselineStep(mode: EvalMode, rows: IntentGoldRow[], report: ClassReport): number {
  const r = applyBaselineGate(
    {
      eval: 'intent',
      mode,
      goldenSet: { rows: rows.length, fingerprint: fingerprintGoldenSet(rows.map(intentGoldenKey)) },
      metrics: { accuracy: report.accuracy, macroF1: report.macroF1 },
    },
    parseBaselineArgs(process.argv),
    {
      tolerance: mode === 'live' ? LIVE_BASELINE_TOLERANCE : OFFLINE_BASELINE_TOLERANCE,
      recordCommand: RECORD_COMMANDS[mode],
    },
  );
  if (r.message) (r.exitCode === 0 ? console.log : console.error)(`\n${r.exitCode === 0 ? '📏' : '❌'} ${r.message}`);
  return r.exitCode;
}

// --live is now WIRED and credential-gated: it needs a real LLM key. This is the
// fail-fast message shown when the key is absent (exit 2 — distinct from a gate
// failure). See data/VOICE-CORPUS-REPORT.md → credential-gated step 3.
const LIVE_NO_KEY =
  '--live is wired but credential-gated: no ANTHROPIC_API_KEY (or AI_PROVIDER_API_KEY) is set.\n' +
  '   Live intent eval routes the held-out split through the production classifier\n' +
  '   (classifyIntent) behind the Layer-2 real gateway. Set ANTHROPIC_API_KEY to run it.\n' +
  '   See data/VOICE-CORPUS-REPORT.md → credential-gated step 3.';

async function runLive(gate: boolean): Promise<void> {
  const key = resolveLiveApiKey();
  if (!key) { console.error(`ℹ️  ${LIVE_NO_KEY}`); process.exit(2); }

  const maxUtterances = parseMaxUtterances(process.argv);
  const full = loadTestSplit();
  if (full.length === 0) { console.error('❌ empty test split; run generate-utterances.ts'); process.exit(1); }
  const sample = sampleDeterministic(full, (r) => r.utterance, maxUtterances);

  // Pre-flight cost cap — abort BEFORE spending if the projection is over cap.
  const capCents = resolveCostCapCents();
  const cost = checkCostCap(sample.map((r) => r.utterance), capCents);
  console.log(`\n🎯 Intent classification eval — LIVE (production classifier)`);
  console.log(`   key source:         ${key.source}`);
  console.log(`   held-out rows:      ${full.length}${maxUtterances ? ` (sampled ${sample.length})` : ''}`);
  console.log(`   projected cost:     ${cost.projectedCents.toFixed(1)}c (cap ${capCents}c, conservative/no-cache)`);
  if (!cost.withinCap) {
    console.error(
      `\n❌ ABORT: projected ${cost.projectedCents.toFixed(1)}c exceeds cap ${capCents}c.\n` +
      `   Lower the sample with --max-utterances N, or raise VOICE_EVAL_COST_CAP_CENTS.`,
    );
    process.exit(3);
  }

  // Build the real gateway lazily (imports the openai-bearing factory only on
  // the live path) so offline runs never load it.
  const { createRealLayerTwoGateway } = await import('../api/src/ai/gateway/real-layer-two-factory');
  const { AgentEventBus } = await import('../api/src/ai/voice-quality/event-bus');
  let spentCents = 0;
  const gateway = createRealLayerTwoGateway({
    apiKey: key.key,
    bus: new AgentEventBus(),
    costTracker: { addCents: (n) => { spentCents += n; }, totalCents: () => spentCents },
  });

  const { pairs, fastPathHits, llmCalls } = await runLiveIntentEval(sample, gateway, {
    tenantId: SYNTHETIC_TENANT_ID,
  }, () => assertActualCostWithinCap(spentCents, capCents));

  const report = classificationReport(pairs);
  console.log(`   evaluated rows:     ${report.total}`);
  console.log(`   accuracy:           ${(report.accuracy * 100).toFixed(1)}%`);
  console.log(`   macro F1:           ${(report.macroF1 * 100).toFixed(1)}%`);
  console.log(`   fast-path hits:     ${fastPathHits}/${report.total} (${((fastPathHits / report.total) * 100).toFixed(1)}%; ${llmCalls} LLM calls)`);
  console.log(`   actual spend:       ${spentCents.toFixed(1)}c`);
  console.log('   worst confusions (gold ⇒ pred):');
  for (const c of report.topConfusions.slice(0, 8)) console.log(`     - ${c.gold} ⇒ ${c.pred}: ${c.count}`);

  const baselineExit = baselineStep('live', sample, report);
  const g = evaluateGate(report.accuracy, LIVE_INTENT_TARGET, gate);
  console.log(`   ${gate ? 'threshold' : 'reference target'}: ${(g.target * 100).toFixed(0)}%`);
  if (baselineExit !== 0) process.exit(baselineExit);
  if (!g.pass) {
    console.error(`\n❌ FAIL: accuracy ${(report.accuracy * 100).toFixed(1)}% < ${(g.target * 100).toFixed(0)}%`);
    process.exit(1);
  }
  console.log(`\n✅ ${gate ? 'PASS (live, gated)' : 'reported (live, not gated)'}.\n`);
}

function runOffline(gate: boolean): void {
  const test = loadTestSplit();
  if (test.length === 0) { console.error('❌ empty test split; run generate-utterances.ts'); process.exit(1); }

  const pairs: { gold: string; pred: string }[] = [];
  for (const r of test) pairs.push({ gold: r.intent, pred: classifyBaseline(r.utterance) });

  const report = classificationReport(pairs);
  console.log(`\n🎯 Intent classification eval — OFFLINE (rule baseline)`);
  console.log(`   held-out test rows: ${report.total}`);
  console.log(`   accuracy:           ${(report.accuracy * 100).toFixed(1)}%`);
  console.log(`   macro F1:           ${(report.macroF1 * 100).toFixed(1)}%`);
  console.log('   worst confusions (gold ⇒ pred):');
  for (const c of report.topConfusions.slice(0, 8)) console.log(`     - ${c.gold} ⇒ ${c.pred}: ${c.count}`);

  const baselineExit = baselineStep('offline', test, report);
  const g = evaluateGate(report.accuracy, OFFLINE_FLOOR, gate);
  console.log(`   ${gate ? 'threshold' : 'reference target'}: ${(g.target * 100).toFixed(0)}%  ` +
    `(LIVE target ${LIVE_INTENT_TARGET * 100}% / offline floor ${OFFLINE_FLOOR * 100}%)`);
  if (baselineExit !== 0) process.exit(baselineExit);
  if (!g.pass) {
    console.error(`\n❌ FAIL: accuracy ${(report.accuracy * 100).toFixed(1)}% < ${(g.target * 100).toFixed(0)}%`);
    process.exit(1);
  }
  console.log(`\n✅ ${gate ? 'PASS' : 'reported (offline, not gated)'}.\n`);
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const gate = process.argv.includes('--gate');
  if (live) await runLive(gate);
  else runOffline(gate);
}

main().catch((e) => {
  console.error(e);
  process.exit(e instanceof ActualCostCapExceededError ? 3 : 1);
});
