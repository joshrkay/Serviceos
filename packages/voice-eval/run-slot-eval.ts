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
 *   production slot projection. Requires ANTHROPIC_API_KEY (or AI_PROVIDER_API_KEY);
 *   fails fast (exit 2) when absent. Enforces LIVE_SLOT_TARGET (0.88) with --gate.
 *
 *   IMPORTANT — service_type is EXCLUDED from the live micro-F1. The classifier
 *   does not emit it: `extractLaunchSlots` fills service_type from
 *   `input.serviceType` (resolved from the tenant vertical pack) and phone from
 *   caller-ID, neither of which is an LLM output. Injecting the gold service_type
 *   as input would rig the metric; leaving it empty would structurally fail an
 *   otherwise-perfect run. So live measures only the four LLM-derived slots
 *   (name, address, time_window, problem_description). service_type live
 *   coverage is a separate, out-of-scope concern (the vertical resolver).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slotReport } from './metrics';
import { extractSlots } from './slot-extractor';
import {
  LIVE_SLOTS,
  LIVE_SLOT_TARGET,
  SYNTHETIC_TENANT_ID,
  checkCostCap,
  evaluateGate,
  parseMaxUtterances,
  resolveCostCapCents,
  resolveLiveApiKey,
  runLiveSlotEval,
  sampleDeterministic,
  type SlotExample,
} from './live-support';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS = resolve(__dirname, '../../data/fixtures/transcripts');

const CRITICAL = ['name', 'address', 'service_type', 'time_window', 'problem_description'];
const OFFLINE_FLOOR = 0.50;

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

interface Transcript { transcript: string; service_type?: string; expected_entities?: Record<string, string> }

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

function loadTranscripts(): Transcript[] {
  return readdirSync(TRANSCRIPTS)
    .filter((x) => x.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(TRANSCRIPTS, f), 'utf8')) as Transcript);
}

const LIVE_NO_KEY =
  '--live is wired but credential-gated: no ANTHROPIC_API_KEY (or AI_PROVIDER_API_KEY) is set.\n' +
  '   Live slot eval routes each transcript through the production classifier\n' +
  '   (classifyIntent) and projects entities via extractLaunchSlots. Set\n' +
  '   ANTHROPIC_API_KEY to run it. See data/VOICE-CORPUS-REPORT.md → credential-gated step 3.';

async function runLive(gate: boolean): Promise<void> {
  const key = resolveLiveApiKey();
  if (!key) { console.error(`ℹ️  ${LIVE_NO_KEY}`); process.exit(2); }

  const maxUtterances = parseMaxUtterances(process.argv);
  const all = loadTranscripts();
  if (all.length === 0) { console.error('❌ no transcripts found'); process.exit(1); }
  const sampled = sampleDeterministic(all, (t) => t.transcript, maxUtterances);

  const capCents = resolveCostCapCents();
  const cost = checkCostCap(sampled.map((t) => t.transcript), capCents);
  console.log(`\n🧩 Slot extraction eval — LIVE (production classifier + extractLaunchSlots)`);
  console.log(`   key source:      ${key.source}`);
  console.log(`   transcripts:     ${all.length}${maxUtterances ? ` (sampled ${sampled.length})` : ''}`);
  console.log(`   projected cost:  ${cost.projectedCents.toFixed(1)}c (cap ${capCents}c, conservative/no-cache)`);
  if (!cost.withinCap) {
    console.error(
      `\n❌ ABORT: projected ${cost.projectedCents.toFixed(1)}c exceeds cap ${capCents}c.\n` +
      `   Lower the sample with --max-utterances N, or raise VOICE_EVAL_COST_CAP_CENTS.`,
    );
    process.exit(3);
  }

  const { createRealLayerTwoGateway } = await import('../api/src/ai/gateway/real-layer-two-factory');
  const { AgentEventBus } = await import('../api/src/ai/voice-quality/event-bus');
  let spentCents = 0;
  const gateway = createRealLayerTwoGateway({
    apiKey: key.key,
    bus: new AgentEventBus(),
    costTracker: { addCents: (n) => { spentCents += n; }, totalCents: () => spentCents },
  });

  const examples: SlotExample[] = sampled.map((t) => ({ transcript: t.transcript, gold: goldSlots(t) }));
  const { examples: results, fastPathHits, llmCalls } = await runLiveSlotEval(examples, gateway, {
    tenantId: SYNTHETIC_TENANT_ID,
  });

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

  const g = evaluateGate(report.microF1, LIVE_SLOT_TARGET, gate);
  console.log(`   ${gate ? 'threshold' : 'reference target'}: ${(g.target * 100).toFixed(0)}%`);
  if (!g.pass) {
    console.error(`\n❌ FAIL: micro F1 ${(report.microF1 * 100).toFixed(1)}% < ${(g.target * 100).toFixed(0)}%`);
    process.exit(1);
  }
  console.log(`\n✅ ${gate ? 'PASS (live, gated)' : 'reported (live, not gated)'}.\n`);
}

function runOffline(gate: boolean): void {
  const examples = loadTranscripts().map((t) => {
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

  const g = evaluateGate(report.microF1, OFFLINE_FLOOR, gate);
  console.log(`   ${gate ? 'threshold' : 'reference target'}: ${(g.target * 100).toFixed(0)}%  (LIVE target ${LIVE_SLOT_TARGET * 100}% / offline floor ${OFFLINE_FLOOR * 100}%)`);
  if (!g.pass) {
    console.error(`\n❌ FAIL: micro F1 ${(report.microF1 * 100).toFixed(1)}% < ${(g.target * 100).toFixed(0)}%`);
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

main().catch((e) => { console.error(e); process.exit(1); });
