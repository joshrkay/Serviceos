#!/usr/bin/env npx tsx
/**
 * run-slot-eval.ts — slot-extraction precision/recall/F1 on the critical slots
 * (name, address, service_type, time_window, problem_description), using the
 * transcript fixtures' expected_entities as gold.
 *
 *   npx tsx packages/voice-eval/run-slot-eval.ts          # offline baseline
 *   npx tsx packages/voice-eval/run-slot-eval.ts --live   # production extractor
 *   npx tsx packages/voice-eval/run-slot-eval.ts --gate   # enforce threshold
 *
 * Matching per slot:
 *   - name / address / service_type : normalized exact match
 *   - time_window / problem_description : token-overlap (Jaccard) >= 0.3, since
 *     these are free-text and phrasing varies.
 *
 * Offline reports + low floor; LIVE enforces F1 >= 0.88 (the goal).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slotReport } from './metrics';
import { extractSlots } from './slot-extractor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS = resolve(__dirname, '../../data/fixtures/transcripts');

const CRITICAL = ['name', 'address', 'service_type', 'time_window', 'problem_description'];
const LIVE_TARGET = 0.88;
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

function loadGold(): { gold: Record<string, string>; pred: Record<string, string> }[] {
  const out: { gold: Record<string, string>; pred: Record<string, string> }[] = [];
  for (const f of readdirSync(TRANSCRIPTS).filter((x) => x.endsWith('.json'))) {
    const t = JSON.parse(readFileSync(join(TRANSCRIPTS, f), 'utf8')) as Transcript;
    const e = t.expected_entities ?? {};
    const gold: Record<string, string> = {
      name: e.customer_name ?? '',
      address: e.address ?? '',
      service_type: t.service_type ?? '',
      time_window: e.appointment_window ?? '',
      problem_description: e.issue ?? '',
    };
    const ex = extractSlots(t.transcript);
    const pred: Record<string, string> = {
      name: ex.name ?? '', address: ex.address ?? '', service_type: ex.service_type ?? '',
      time_window: ex.time_window ?? '', problem_description: ex.problem_description ?? '',
    };
    out.push({ gold, pred });
  }
  return out;
}

// LIVE (--live) is intentionally NOT wired in this build (see run-intent-eval.ts
// and data/VOICE-CORPUS-REPORT.md credential-gated step 3): there is no single
// production "extract these 5 slots" function — the inbound entity resolver would
// need adapting to the eval's slot set — and the offline harness deliberately
// avoids importing the gateway/runtime. This is the wiring point + gate.
const LIVE_NOT_WIRED =
  '--live is not wired in this build.\n' +
  '   The >=0.88 live gate needs a production slot extractor adapted to the eval\'s\n' +
  '   5 critical slots (name, address, service_type, time_window, problem_description)\n' +
  '   behind a constructed LLMGateway. Wire it here to enable --live.\n' +
  '   See data/VOICE-CORPUS-REPORT.md → credential-gated step 3.';

function main(): void {
  const live = process.argv.includes('--live');
  const gate = process.argv.includes('--gate');

  // Fail fast and explicitly on --live rather than starting a run that cannot
  // evaluate the production extractor (exit 2 = not-implemented, not a gate fail).
  if (live) { console.error(`ℹ️  ${LIVE_NOT_WIRED}`); process.exit(2); }

  const examples = loadGold();
  const report = slotReport(examples, CRITICAL, matchFn);

  console.log(`\n🧩 Slot extraction eval — OFFLINE (heuristic baseline)`);
  console.log(`   transcripts: ${examples.length}`);
  for (const s of CRITICAL) {
    const m = report.perSlot[s];
    console.log(`   ${s.padEnd(22)} P=${(m.precision * 100).toFixed(0)}% R=${(m.recall * 100).toFixed(0)}% F1=${(m.f1 * 100).toFixed(1)}%  (tp=${m.tp} fp=${m.fp} fn=${m.fn})`);
  }
  console.log(`   micro F1: ${(report.microF1 * 100).toFixed(1)}%`);

  const target = OFFLINE_FLOOR;
  const enforce = gate;
  console.log(`   ${enforce ? 'threshold' : 'reference target'}: ${(target * 100).toFixed(0)}%  (LIVE target ${LIVE_TARGET * 100}% / offline floor ${OFFLINE_FLOOR * 100}%)`);

  if (enforce && report.microF1 < target) {
    console.error(`\n❌ FAIL: micro F1 ${(report.microF1 * 100).toFixed(1)}% < ${(target * 100).toFixed(0)}%`);
    process.exit(1);
  }
  console.log(`\n✅ ${enforce ? 'PASS' : 'reported (offline, not gated)'}.\n`);
}

main();
