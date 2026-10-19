#!/usr/bin/env npx tsx
/**
 * drafting-golden-eval.ts — cost-capped real-model eval of the drafting
 * prompts the classifier evals never touch (OBS-3 review rounds 1-2):
 * draft_estimate (catalog-grounded), update_brand_voice, the Google-review
 * public reply and the brand_voice_v1 composer that drafts customer SMS.
 *
 *   npx tsx packages/api/scripts/drafting-golden-eval.ts --live --gate \
 *     --baseline packages/voice-eval/baselines/drafting-live.json
 *   npx tsx packages/api/scripts/drafting-golden-eval.ts --live \
 *     --record-baseline packages/voice-eval/baselines/drafting-live.json
 *
 * Runs DRAFTING_GOLDEN_CASES (src/ai/voice-quality/drafting-golden) through
 * the production task code behind the PRODUCTION gateway (createLLMGateway
 * via createHarnessLLMGateway, from AI_PROVIDER_API_KEY / AI_PROVIDER_BASE_URL
 * / AI_*_MODEL), exactly as agent-path-smoke.ts does for the classifier.
 *
 * With --gate the run fails when ANY safety check fails (an uncatalogued
 * price that could auto-approve, a catalog line off its catalog price, a
 * reply or composed SMS carrying a link or discount, an SMS that took its
 * signoff from the caller context), whatever the baseline says. --baseline
 * then compares the quality metrics with the recorded live baseline
 * (packages/voice-eval/baseline.ts — fails closed on a placeholder).
 *
 * Exit codes:
 *   0 — pass (or no --gate / --baseline)
 *   1 — a safety check failed, or the quality metrics regressed past tolerance
 *   2 — no --live, or no AI_PROVIDER_API_KEY (never a silent offline pass)
 *   3 — projected cost exceeds the cap, model unpriced, or actual spend over cap
 *   4 — the baseline is an unrecorded placeholder
 *
 * Env:
 *   AI_PROVIDER_API_KEY (+ AI_PROVIDER_BASE_URL, AI_*_MODEL) — required
 *   VOICE_EVAL_COST_CAP_CENTS — default 50
 *   DRAFTING_GOLDEN_OUT — optional path for the JSON report artifact
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHarnessLLMGateway } from '../src/ai/gateway/harness-gateway';
import {
  DRAFTING_GOLDEN_CASES,
  draftingGoldenKeys,
  projectDraftingGoldenCents,
  runDraftingGolden,
} from '../src/ai/voice-quality/drafting-golden';
import { selectPathSmokeProvider, withPathSmokeSpendTracking } from '../src/ai/voice-quality/path-smoke';
import { loadConfig } from '../src/shared/config';
import { applyBaselineGate, fingerprintGoldenSet, parseBaselineArgs } from '../../voice-eval/baseline';

/**
 * Noise band for the recorded drafting baseline, compared per metric. For
 * the composer task (three cases, two quality checks each) one model flip
 * moves quality.brand_voice_v1 by a sixth, so 0.2 absorbs a single flip and
 * still fails a prompt that breaks the whole task; tasks with fewer checks
 * per case swing further on one flip. Owner-tunable in the baseline file (re-recording keeps it).
 */
const DRAFTING_LIVE_TOLERANCE = 0.2;
const DEFAULT_CAP_CENTS = 50;

const RECORD_COMMAND =
  'AI_PROVIDER_API_KEY=... AI_PROVIDER_BASE_URL=https://api.openai.com/v1 AI_DEFAULT_MODEL=gpt-4o-mini ' +
  'AI_LIGHTWEIGHT_MODEL=gpt-4o-mini AI_STANDARD_MODEL=gpt-4o-mini AI_COMPLEX_MODEL=gpt-4o ' +
  'VOICE_EVAL_COST_CAP_CENTS=25 npx tsx packages/api/scripts/drafting-golden-eval.ts --live ' +
  '--record-baseline packages/voice-eval/baselines/drafting-live.json';

class ActualCostCapExceededError extends Error {
  constructor(capCents: number, spentCents: number) {
    super(`drafting golden eval actual cost ${spentCents.toFixed(2)}¢ exceeded cap ${capCents.toFixed(2)}¢`);
    this.name = 'ActualCostCapExceededError';
  }
}

const argv = process.argv.slice(2);

function capCents(): number {
  const n = Number(process.env.VOICE_EVAL_COST_CAP_CENTS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP_CENTS;
}

async function main(): Promise<number> {
  if (!argv.includes('--live')) {
    console.error('❌ the drafting golden set has no offline mode — pass --live (it calls the real model). Exit 2.');
    return 2;
  }
  const selection = selectPathSmokeProvider(process.env);
  if (!selection || selection.kind !== 'production') {
    console.error(
      '❌ drafting-golden-eval requires AI_PROVIDER_API_KEY (the production provider).\n' +
        '   It is a real-model gate — it never falls back to mocks or another provider. Exit 2.',
    );
    return 2;
  }

  // Price every call at the costliest tier the env configures (draft_estimate
  // routes to complex), so the projection over-states, never under-states.
  const pricedModel = process.env.AI_COMPLEX_MODEL?.trim() || selection.model;
  const projected = projectDraftingGoldenCents(pricedModel);
  const cap = capCents();
  console.log('\n✍️  Drafting golden eval — REAL model');
  console.log(`   cases:          ${DRAFTING_GOLDEN_CASES.length} (draft_estimate, brand voice, review reply, composer SMS)`);
  if (projected === null) {
    console.error(`❌ ABORT: no known price for model ${pricedModel} — cannot enforce the cost cap. Exit 3.`);
    return 3;
  }
  console.log(`   projected cost: ${projected.toFixed(1)}¢ at ${pricedModel} (cap ${cap}¢, conservative)`);
  if (projected > cap) {
    console.error(`❌ ABORT: projected ${projected.toFixed(1)}¢ exceeds cap ${cap}¢. Exit 3.`);
    return 3;
  }

  let spentCents = 0;
  const gateway = withPathSmokeSpendTracking(createHarnessLLMGateway(loadConfig(process.env)), {
    fallbackModel: pricedModel,
    addCents: (n) => {
      spentCents += n;
    },
  });

  const report = await runDraftingGolden({
    gateway,
    afterCall: () => {
      if (spentCents > cap) throw new ActualCostCapExceededError(cap, spentCents);
    },
  });

  for (const c of report.cases) {
    for (const x of c.checks) {
      console.log(`   ${x.pass ? '✅' : x.kind === 'safety' ? '🛑' : '❌'} ${c.id} [${x.kind}] ${x.name} — ${x.detail}`);
    }
  }
  for (const [k, v] of Object.entries(report.metrics)) console.log(`   ${k}: ${(v * 100).toFixed(1)}%`);
  console.log(`   spent: ~${spentCents.toFixed(2)}¢ (projected ${projected.toFixed(1)}¢)`);

  const outPath = process.env.DRAFTING_GOLDEN_OUT;
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ ...report, spentCents, projectedCents: projected, capCents: cap }, null, 2));
  }

  const keys = draftingGoldenKeys();
  const baseline = applyBaselineGate(
    {
      eval: 'drafting',
      mode: 'live',
      goldenSet: { rows: keys.length, fingerprint: fingerprintGoldenSet(keys) },
      metrics: report.metrics,
    },
    parseBaselineArgs(argv),
    { tolerance: DRAFTING_LIVE_TOLERANCE, recordCommand: RECORD_COMMAND },
  );
  if (baseline.message) console.log(`   ${baseline.message}`);

  if (argv.includes('--gate') && report.safetyViolations.length > 0) {
    console.error(`\n❌ drafting safety gate failed:\n   ${report.safetyViolations.join('\n   ')}`);
    return 1;
  }
  return baseline.exitCode;
}

main()
  .then((code) => {
    // The production gateway's resilience/quota stack may hold timers; this
    // is a one-shot CLI, so exit explicitly.
    process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    process.exit(err instanceof ActualCostCapExceededError ? 3 : 1);
  });
