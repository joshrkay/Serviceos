#!/usr/bin/env npx tsx
/**
 * agent-path-smoke.ts — cost-capped real-LLM smoke over critical agent paths.
 *
 *   npx tsx packages/api/scripts/agent-path-smoke.ts
 *   npx tsx packages/api/scripts/agent-path-smoke.ts --gate
 *   npx tsx packages/api/scripts/agent-path-smoke.ts --json
 *
 * Routes PATH_SMOKE_CASES through the production classifier (classifyIntent)
 * behind the PRODUCTION gateway: `createLLMGateway` (the same factory app.ts
 * uses) built from AI_PROVIDER_API_KEY / AI_PROVIDER_BASE_URL / AI_*_MODEL —
 * i.e. the provider + model production actually runs (Railway prod/dev:
 * api.openai.com, gpt-4o-mini for classify). Proves model behavior on book /
 * quote / escalate / negotiate / complaint / Spanish — the critical subgraph
 * the mock Layer-1 gate cannot see.
 *
 * ANTHROPIC_API_KEY is an explicit local-dev fallback only (the Layer-2
 * harness gateway, Haiku via Anthropic's OpenAI-compat endpoint); the run
 * logs loudly that it is NOT the production provider.
 *
 * Exit codes:
 *   0 — pass (or no --gate)
 *   1 — gate failed (pass ratio below threshold)
 *   2 — no API key (fail-fast; never silent offline pass)
 *   3 — projected cost exceeds cap, model unpriced, or actual spend over cap
 *
 * Env:
 *   AI_PROVIDER_API_KEY (+ AI_PROVIDER_BASE_URL, AI_DEFAULT_MODEL,
 *     AI_LIGHTWEIGHT_MODEL / AI_STANDARD_MODEL / AI_COMPLEX_MODEL) — preferred
 *   ANTHROPIC_API_KEY — fallback only when AI_PROVIDER_API_KEY is unset
 *   AGENT_PATH_SMOKE_COST_CAP_CENTS — default 100 ($1)
 *   AGENT_PATH_SMOKE_PASS_RATIO — default 0.8
 *   AGENT_PATH_SMOKE_OUT — optional path for JSON report artifact
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LLMGateway } from '../src/ai/gateway/gateway';
import { createLLMGateway } from '../src/ai/gateway/factory';
import { createRealLayerTwoGateway } from '../src/ai/gateway/real-layer-two-factory';
import { AgentEventBus } from '../src/ai/voice-quality/event-bus';
import {
  PATH_SMOKE_DEFAULT_COST_CAP_CENTS,
  PATH_SMOKE_PASS_RATIO,
  allPathSmokeUtterances,
  describePathSmokeProvider,
  projectPathSmokeCents,
  runPathSmoke,
  selectPathSmokeProvider,
  withPathSmokeSpendTracking,
  type PathSmokeProviderSelection,
} from '../src/ai/voice-quality/path-smoke';
import { SYSTEM_PROMPT } from '../src/ai/orchestration/intent-classifier';
import { loadConfig } from '../src/shared/config';

// Per-model rates live in src/ai/voice-quality/path-smoke/provider.ts.
// #899 — derived from the REAL prompt instead of a hand-maintained constant
// (the old literal 13,500 had silently fallen BELOW the actual prompt size,
// underestimating spend — the unsafe direction for a preflight cost cap).
// This script already imports api src modules, so it sizes against the same
// SYSTEM_PROMPT the smoke calls send (path-smoke passes no surface profile ⇒
// the full 'operator' taxonomy), chars/4 like live-support.estimateTokens,
// with the same 1.15× safety margin voice-eval-live.test.ts pins.
const EST_SYSTEM_PROMPT_TOKENS = Math.ceil((SYSTEM_PROMPT.length / 4) * 1.15);
const EST_OUTPUT_TOKENS_PER_CALL = 250;

class ActualCostCapExceededError extends Error {
  constructor(
    readonly capCents: number,
    readonly spentCents: number,
  ) {
    super(
      `agent path smoke actual cost ${spentCents.toFixed(2)}¢ exceeded cap ${capCents.toFixed(2)}¢`,
    );
    this.name = 'ActualCostCapExceededError';
  }
}

const argv = process.argv.slice(2);
const gate = argv.includes('--gate');
const asJson = argv.includes('--json');

function resolveCostCapCents(): number {
  const raw = process.env.AGENT_PATH_SMOKE_COST_CAP_CENTS;
  if (!raw || raw.trim() === '') return PATH_SMOKE_DEFAULT_COST_CAP_CENTS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : PATH_SMOKE_DEFAULT_COST_CAP_CENTS;
}

function resolvePassRatio(): number {
  const raw = process.env.AGENT_PATH_SMOKE_PASS_RATIO;
  if (!raw || raw.trim() === '') return PATH_SMOKE_PASS_RATIO;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : PATH_SMOKE_PASS_RATIO;
}

/**
 * Build the gateway for the selected provider. The production selection goes
 * through `createLLMGateway` — the exact factory app.ts uses (resilience
 * stack, tier routing, provider/model mismatch check) — never a hand-rolled
 * client.
 */
function buildGateway(
  selection: PathSmokeProviderSelection,
  addCents: (n: number) => void,
): LLMGateway {
  if (selection.kind === 'production') {
    return withPathSmokeSpendTracking(createLLMGateway(loadConfig(process.env)), {
      fallbackModel: selection.model,
      addCents,
    });
  }
  let harnessCents = 0;
  return createRealLayerTwoGateway({
    apiKey: selection.apiKey,
    bus: new AgentEventBus(),
    costTracker: {
      addCents(n: number) {
        harnessCents += n;
        addCents(n);
      },
      totalCents: () => harnessCents,
    },
  });
}

async function main(): Promise<void> {
  const selection = selectPathSmokeProvider(process.env);
  if (!selection) {
    console.error(
      '❌ agent-path-smoke requires AI_PROVIDER_API_KEY (the production provider)\n' +
        '   or, as a local fallback only, ANTHROPIC_API_KEY.\n' +
        '   This is a real-LLM gate — it never falls back to mocks.\n' +
        '   Exit 2 (no key).',
    );
    process.exit(2);
  }

  const utterances = allPathSmokeUtterances();
  const capCents = resolveCostCapCents();
  const passRatio = resolvePassRatio();
  const projected = projectPathSmokeCents({
    model: selection.model,
    utterances,
    systemPromptTokens: EST_SYSTEM_PROMPT_TOKENS,
    outputTokensPerCall: EST_OUTPUT_TOKENS_PER_CALL,
  });

  console.log(`\n🔥 Agent path smoke — REAL model`);
  console.log(`   provider:       ${describePathSmokeProvider(selection)}`);
  if (selection.kind !== 'production') {
    console.warn(
      '⚠️  ANTHROPIC_API_KEY fallback — this does NOT exercise the provider\n' +
        '   production runs. Set AI_PROVIDER_API_KEY (+ base URL / models).',
    );
  }
  if (projected === null) {
    console.error(
      `❌ ABORT: no known price for model ${selection.model} — cannot enforce the cost cap.\n` +
        '   Add it to the rate table in src/ai/voice-quality/path-smoke/provider.ts.',
    );
    process.exit(3);
  }
  console.log(`   cases/turns:    ${utterances.length} classify calls`);
  console.log(
    `   projected cost: ${projected.toFixed(1)}¢ (cap ${capCents}¢, conservative/no-cache)`,
  );
  console.log(`   pass ratio:     need ≥ ${(passRatio * 100).toFixed(0)}%\n`);

  if (projected > capCents) {
    console.error(
      `❌ ABORT: projected ${projected.toFixed(1)}¢ exceeds cap ${capCents}¢.\n` +
        `   Raise AGENT_PATH_SMOKE_COST_CAP_CENTS or shrink PATH_SMOKE_CASES.`,
    );
    process.exit(3);
  }

  let spentCents = 0;
  const gateway = buildGateway(selection, (n) => {
    spentCents += n;
  });

  const report = await runPathSmoke({
    gateway,
    passRatio,
    afterTurn: () => {
      if (spentCents > capCents) {
        throw new ActualCostCapExceededError(capCents, spentCents);
      }
    },
  });

  const fullReport = {
    ...report,
    spentCents,
    projectedCents: projected,
    capCents,
    provider: selection.kind,
    keySource: selection.keySource,
    baseUrl: selection.baseUrl,
    model: selection.model,
  };

  if (asJson) {
    console.log(JSON.stringify(fullReport, null, 2));
  } else {
    for (const line of report.summaryLines) console.log(line);
    console.log(
      `\n   spent: ~${spentCents.toFixed(2)}¢ (projected ${projected.toFixed(1)}¢)`,
    );
  }

  const outPath = process.env.AGENT_PATH_SMOKE_OUT;
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(fullReport, null, 2));
    console.error(`Wrote ${outPath}`);
  }

  if (gate && !report.gatePassed) {
    console.error(
      `\n❌ path-smoke gate failed: ${(report.passRatio * 100).toFixed(0)}% < ${(passRatio * 100).toFixed(0)}%`,
    );
    process.exit(1);
  }
  if (gate) {
    console.error(
      `\n✅ path-smoke gate passed (${(report.passRatio * 100).toFixed(0)}%)`,
    );
  }
}

main()
  .then(() => {
    // The production gateway's resilience/quota stack may hold timers; this
    // is a one-shot CLI, so exit explicitly once the report is written.
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(err instanceof ActualCostCapExceededError ? 3 : 1);
  });
