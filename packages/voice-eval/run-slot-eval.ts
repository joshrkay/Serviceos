#!/usr/bin/env npx tsx
/**
 * run-slot-eval.ts — slot-extraction precision/recall/F1 on the critical slots,
 * using the transcript fixtures' expected_entities as gold.
 *
 *   npx tsx packages/voice-eval/run-slot-eval.ts                  # offline baseline
 *   npx tsx packages/voice-eval/run-slot-eval.ts --live           # production path
 *   npx tsx packages/voice-eval/run-slot-eval.ts --live --gate    # enforce 0.88 target
 *   npx tsx packages/voice-eval/run-slot-eval.ts --live --max-utterances 100
 *
 * Matching per slot:
 *   - name / address / service_type : normalized exact / containment match
 *   - time_window / problem_description : token-overlap (Jaccard) >= 0.3, since
 *     these are free-text and phrasing varies.
 *
 * OFFLINE (default): heuristic baseline (slot-extractor.ts) over all 5 critical
 *   slots. Reports + low floor; --gate enforces the floor.
 * LIVE (--live): routes each transcript through the PRODUCTION classifier
 *   (classifyIntent) and projects entities via `extractLaunchSlots` — the real
 *   production slot projection, behind the PRODUCTION gateway (createLLMGateway
 *   from AI_PROVIDER_API_KEY / AI_PROVIDER_BASE_URL / AI_*_MODEL — prod runs
 *   OpenAI gpt-4o-mini). ANTHROPIC_API_KEY is a local fallback only (logged as
 *   NOT the production provider). Fails fast (exit 2) when neither is set. Enforces LIVE_SLOT_TARGET (0.88) with --gate.
 *
 *   IMPORTANT — service_type is EXCLUDED from the live micro-F1. The classifier
 *   does not emit it: `extractLaunchSlots` fills service_type from
 *   `input.serviceType` (resolved from the tenant vertical pack) and phone from
 *   caller-ID, neither of which is an LLM output. Injecting the gold service_type
 *   as input would rig the metric; leaving it empty would structurally fail an
 *   otherwise-perfect run. So live measures only the four LLM-derived slots
 *   (name, address, time_window, problem_description). service_type live
 *   coverage is a separate, out-of-scope concern (the vertical resolver).
 *
 * Baseline regression gate (#839, both modes — see baseline.ts):
 *   --baseline <file>          fail (exit 1) if micro-F1 or any per-slot F1
 *                              dropped past the baseline's tolerance or the gold
 *                              set changed; exit 4 on an unrecorded placeholder.
 *   --record-baseline <file>   write this run's metrics as the new baseline.
 */
import { slotReport, type SlotReport } from './metrics';
import { extractSlots } from './slot-extractor';
import { loadSlotTranscripts as loadTranscripts, slotGoldenKey, type Transcript } from './corpus';
import {
  LIVE_BASELINE_TOLERANCE,
  OFFLINE_BASELINE_TOLERANCE,
  applyBaselineGate,
  fingerprintGoldenSet,
  parseBaselineArgs,
  type EvalMode,
} from './baseline';
import {
  assertActualCostWithinCap,
  LIVE_SLOTS,
  LIVE_SLOT_TARGET,
  LIVE_FALLBACK_WARNING,
  LIVE_RECORD_COMMANDS,
  SYNTHETIC_TENANT_ID,
  buildLiveGateway,
  checkCostCap,
  describeLiveProvider,
  evaluateGate,
  parseMaxUtterances,
  resolveCostCapCents,
  runEvalCli,
  runLiveSlotEval,
  selectLiveProvider,
  sampleDeterministic,
  type SlotExample,
} from './live-support';

const CRITICAL = ['name', 'address', 'service_type', 'time_window', 'problem_description'];
const OFFLINE_FLOOR = 0.50;

const RECORD_COMMANDS: Record<EvalMode, string> = {
  offline: 'npx tsx packages/voice-eval/run-slot-eval.ts --record-baseline packages/voice-eval/baselines/slot-offline.json',
  live: LIVE_RECORD_COMMANDS.slot,
};

/** Compare/record against a baseline when asked; returns the exit code it demands. */
function baselineStep(mode: EvalMode, gold: Transcript[], report: SlotReport, slots: string[]): number {
  const metrics: Record<string, number> = { microF1: report.microF1 };
  for (const s of slots) metrics[`f1.${s}`] = report.perSlot[s].f1;
  const r = applyBaselineGate(
    {
      eval: 'slot',
      mode,
      goldenSet: { rows: gold.length, fingerprint: fingerprintGoldenSet(gold.map(slotGoldenKey)) },
      metrics,
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

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function jaccard(a: string, b: string): number {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function matchFn(slot: string, gold: string, pred: string): boolean {
  if (slot === 'time_window' || slot === 'problem_description') return jaccard(gold, pred) >= 0.3;
  return norm(gold) === norm(pred) || norm(pred).includes(norm(gold)) || norm(gold).includes(norm(pred));
}

function goldSlots(t: Transcript): Record<string, string> {
  const e = t.expected_entities ?? {};
  return {
    name: e.customer_name ?? '',
    address: e.address ?? '',
    service_type: t.service_type ?? '',
    time_window: e.appointment_window ?? '',
    problem_description: e.issue ?? '',
  };
}

const LIVE_NO_KEY =
  '--live is wired but credential-gated: no AI_PROVIDER_API_KEY (or fallback ANTHROPIC_API_KEY) is set.\n' +
  '   Live slot eval routes each transcript through the production classifier\n' +
  '   (classifyIntent, behind the production gateway) and projects entities via\n' +
  '   extractLaunchSlots. Set AI_PROVIDER_API_KEY (+ AI_PROVIDER_BASE_URL / AI_*_MODEL,\n' +
  '   as in baselines/slot-live.json recordCommand) to run it.';

async function runLive(gate: boolean): Promise<number> {
  const selection = await selectLiveProvider();
  if (!selection) { console.error(`ℹ️  ${LIVE_NO_KEY}`); return 2; }

  const maxUtterances = parseMaxUtterances(process.argv);
  const all = loadTranscripts();
  if (all.length === 0) { console.error('❌ no transcripts found'); return 1; }
  const sampled = sampleDeterministic(all, (t) => t.transcript, maxUtterances);

  const capCents = resolveCostCapCents();
  const cost = await checkCostCap(sampled.map((t) => t.transcript), capCents, selection.model);
  console.log(`\n🧩 Slot extraction eval — LIVE (production classifier + extractLaunchSlots)`);
  console.log(`   provider:        ${await describeLiveProvider(selection)}`);
  if (selection.kind !== 'production') console.warn(LIVE_FALLBACK_WARNING);
  console.log(`   transcripts:     ${all.length}${maxUtterances ? ` (sampled ${sampled.length})` : ''}`);
  if (cost.projectedCents === null) {
    console.error(`\n❌ ABORT: no known price for model ${selection.model} — cannot enforce the cost cap.`);
    return 3;
  }
  console.log(`   projected cost:  ${cost.projectedCents.toFixed(1)}c (cap ${capCents}c, conservative/no-cache)`);
  if (!cost.withinCap) {
    console.error(
      `\n❌ ABORT: projected ${cost.projectedCents.toFixed(1)}c exceeds cap ${capCents}c.\n` +
      `   Lower the sample with --max-utterances N, or raise VOICE_EVAL_COST_CAP_CENTS.`,
    );
    return 3;
  }

  let spentCents = 0;
  const gateway = await buildLiveGateway(selection, (n) => { spentCents += n; });

  const examples: SlotExample[] = sampled.map((t) => ({ transcript: t.transcript, gold: goldSlots(t) }));
  const { examples: results, fastPathHits, llmCalls } = await runLiveSlotEval(examples, gateway, {
    tenantId: SYNTHETIC_TENANT_ID,
  }, () => assertActualCostWithinCap(spentCents, capCents));

  const slots = [...LIVE_SLOTS];
  const report = slotReport(results, slots, matchFn);
  console.log(`   evaluated:       ${results.length}`);
  console.log(`   slots (live):    ${slots.join(', ')}`);
  console.log(`   note:            service_type EXCLUDED — not classifier-sourced (vertical resolver)`);
  for (const s of slots) {
    const m = report.perSlot[s];
    console.log(`   ${s.padEnd(22)} P=${(m.precision * 100).toFixed(0)}% R=${(m.recall * 100).toFixed(0)}% F1=${(m.f1 * 100).toFixed(1)}%  (tp=${m.tp} fp=${m.fp} fn=${m.fn})`);
  }
  console.log(`   micro F1:        ${(report.microF1 * 100).toFixed(1)}%`);
  console.log(`   fast-path hits:  ${fastPathHits}/${results.length} (${llmCalls} LLM calls)`);
  console.log(`   actual spend:    ${spentCents.toFixed(1)}c`);

  const baselineExit = baselineStep('live', sampled, report, slots);
  const g = evaluateGate(report.microF1, LIVE_SLOT_TARGET, gate);
  console.log(`   ${gate ? 'threshold' : 'reference target'}: ${(g.target * 100).toFixed(0)}%`);
  if (baselineExit !== 0) return baselineExit;
  if (!g.pass) {
    console.error(`\n❌ FAIL: micro F1 ${(report.microF1 * 100).toFixed(1)}% < ${(g.target * 100).toFixed(0)}%`);
    return 1;
  }
  console.log(`\n✅ ${gate ? 'PASS (live, gated)' : 'reported (live, not gated)'}.\n`);
  return 0;
}

function runOffline(gate: boolean): number {
  const transcripts = loadTranscripts();
  const examples = transcripts.map((t) => {
    const gold = goldSlots(t);
    const ex = extractSlots(t.transcript);
    const pred: Record<string, string> = {
      name: ex.name ?? '', address: ex.address ?? '', service_type: ex.service_type ?? '',
      time_window: ex.time_window ?? '', problem_description: ex.problem_description ?? '',
    };
    return { gold, pred };
  });
  const report = slotReport(examples, CRITICAL, matchFn);

  console.log(`\n🧩 Slot extraction eval — OFFLINE (heuristic baseline)`);
  console.log(`   transcripts: ${examples.length}`);
  for (const s of CRITICAL) {
    const m = report.perSlot[s];
    console.log(`   ${s.padEnd(22)} P=${(m.precision * 100).toFixed(0)}% R=${(m.recall * 100).toFixed(0)}% F1=${(m.f1 * 100).toFixed(1)}%  (tp=${m.tp} fp=${m.fp} fn=${m.fn})`);
  }
  console.log(`   micro F1: ${(report.microF1 * 100).toFixed(1)}%`);

  const baselineExit = baselineStep('offline', transcripts, report, CRITICAL);
  const g = evaluateGate(report.microF1, OFFLINE_FLOOR, gate);
  console.log(`   ${gate ? 'threshold' : 'reference target'}: ${(g.target * 100).toFixed(0)}%  (LIVE target ${LIVE_SLOT_TARGET * 100}% / offline floor ${OFFLINE_FLOOR * 100}%)`);
  if (baselineExit !== 0) return baselineExit;
  if (!g.pass) {
    console.error(`\n❌ FAIL: micro F1 ${(report.microF1 * 100).toFixed(1)}% < ${(g.target * 100).toFixed(0)}%`);
    return 1;
  }
  console.log(`\n✅ ${gate ? 'PASS' : 'reported (offline, not gated)'}.\n`);
  return 0;
}

async function main(): Promise<number> {
  const live = process.argv.includes('--live');
  const gate = process.argv.includes('--gate');
  return live ? runLive(gate) : runOffline(gate);
}

runEvalCli(main);
