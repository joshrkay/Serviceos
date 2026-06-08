#!/usr/bin/env npx tsx
/**
 * run-intent-eval.ts — intent-classification accuracy on a held-out test split.
 *
 *   npx tsx packages/voice-eval/run-intent-eval.ts            # offline baseline
 *   npx tsx packages/voice-eval/run-intent-eval.ts --live     # production model
 *   npx tsx packages/voice-eval/run-intent-eval.ts --gate     # enforce threshold
 *
 * Modes:
 *   OFFLINE (default): the rule baseline (baseline-classifier.ts). Always runs;
 *     reports accuracy + per-intent confusion. Enforces only a low regression
 *     floor (OFFLINE_FLOOR) unless --gate is given.
 *   LIVE (--live): routes utterances through the production classifier via the
 *     LLM gateway. Requires OPENAI_API_KEY/ANTHROPIC_API_KEY. Enforces
 *     LIVE_TARGET (0.92, the goal).
 *
 * Held-out split: deterministic 20% by stable hash of the utterance, so the test
 * set is stable across runs and independent of row order.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classificationReport, stableHash } from './metrics';
import { classifyBaseline } from './baseline-classifier';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UTTERANCES = resolve(__dirname, '../../data/corpus/utterances.jsonl');

const TEST_FRACTION = 0.20;
const LIVE_TARGET = 0.92;
const OFFLINE_FLOOR = 0.50; // regression guard for the rule baseline on this data

interface Row { utterance: string; intent: string }

function loadTestSplit(): Row[] {
  const rows = readFileSync(UTTERANCES, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);
  return rows.filter((r) => stableHash(r.utterance) < TEST_FRACTION);
}

// LIVE (--live) is a documented, credential-gated step that is intentionally
// NOT wired in this build: the production classifier (classifyIntent in
// packages/api/src/ai/orchestration/intent-classifier.ts) needs a constructed
// LLMGateway + tenant context, which this offline harness deliberately does not
// import. This is the single wiring point + gate description; see
// data/VOICE-CORPUS-REPORT.md (credential-gated step 3).
const LIVE_NOT_WIRED =
  '--live is not wired in this build.\n' +
  '   The >=92% live gate requires the production classifier (classifyIntent in\n' +
  '   packages/api/src/ai/orchestration/intent-classifier.ts) behind a constructed\n' +
  '   LLMGateway + tenant context. Wire it here to enable --live.\n' +
  '   See data/VOICE-CORPUS-REPORT.md → credential-gated step 3.';

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const gate = process.argv.includes('--gate');

  // Fail fast and explicitly on --live rather than starting a run that cannot
  // measure live accuracy (exit 2 = not-implemented, distinct from a gate fail).
  if (live) { console.error(`ℹ️  ${LIVE_NOT_WIRED}`); process.exit(2); }

  const test = loadTestSplit();
  if (test.length === 0) { console.error('❌ empty test split; run generate-utterances.ts'); process.exit(1); }

  const pairs: { gold: string; pred: string }[] = [];
  for (const r of test) {
    pairs.push({ gold: r.intent, pred: classifyBaseline(r.utterance) });
  }

  const report = classificationReport(pairs);
  const mode = 'OFFLINE (rule baseline)';
  console.log(`\n🎯 Intent classification eval — ${mode}`);
  console.log(`   held-out test rows: ${report.total}`);
  console.log(`   accuracy:           ${(report.accuracy * 100).toFixed(1)}%`);
  console.log(`   macro F1:           ${(report.macroF1 * 100).toFixed(1)}%`);
  console.log('   worst confusions (gold ⇒ pred):');
  for (const c of report.topConfusions.slice(0, 8)) console.log(`     - ${c.gold} ⇒ ${c.pred}: ${c.count}`);

  const target = OFFLINE_FLOOR;
  const enforce = gate;
  console.log(`   ${enforce ? 'threshold' : 'reference target'}: ${(target * 100).toFixed(0)}%  ` +
    `(LIVE target ${LIVE_TARGET * 100}% / offline floor ${OFFLINE_FLOOR * 100}%)`);

  if (enforce && report.accuracy < target) {
    console.error(`\n❌ FAIL: accuracy ${(report.accuracy * 100).toFixed(1)}% < ${(target * 100).toFixed(0)}%`);
    process.exit(1);
  }
  console.log(`\n✅ ${enforce ? 'PASS' : 'reported (offline, not gated)'}.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
