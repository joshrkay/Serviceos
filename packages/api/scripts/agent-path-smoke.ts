#!/usr/bin/env npx tsx
/**
 * agent-path-smoke.ts — cost-capped real-LLM smoke over critical agent paths.
 *
 *   npx tsx packages/api/scripts/agent-path-smoke.ts
 *   npx tsx packages/api/scripts/agent-path-smoke.ts --gate
 *   npx tsx packages/api/scripts/agent-path-smoke.ts --json
 *
 * Routes PATH_SMOKE_CASES through the production classifier (classifyIntent)
 * behind the Layer-2 real gateway (Anthropic OpenAI-compat). Proves model
 * behavior on book / quote / escalate / negotiate / complaint / Spanish —
 * the critical subgraph the mock Layer-1 gate cannot see.
 *
 * Exit codes:
 *   0 — pass (or no --gate)
 *   1 — gate failed (pass ratio below threshold)
 *   2 — no API key (fail-fast; never silent offline pass)
 *   3 — projected cost exceeds cap (abort before spending)
 *
 * Env:
 *   ANTHROPIC_API_KEY or AI_PROVIDER_API_KEY — required
 *   AGENT_PATH_SMOKE_COST_CAP_CENTS — default 100 ($1)
 *   AGENT_PATH_SMOKE_PASS_RATIO — default 0.8
 *   AGENT_PATH_SMOKE_OUT — optional path for JSON report artifact
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentEventBus } from '../src/ai/voice-quality/event-bus';
import { createRealLayerTwoGateway } from '../src/ai/gateway/real-layer-two-factory';
import {
  PATH_SMOKE_DEFAULT_COST_CAP_CENTS,
  PATH_SMOKE_PASS_RATIO,
  allPathSmokeUtterances,
  runPathSmoke,
} from '../src/ai/voice-quality/path-smoke';

// Cost projection mirrors packages/voice-eval/live-support.ts (Haiku rates +
// conservative system-prompt size). Duplicated as plain constants so this CLI
// does not depend on the voice-eval package workspace membership.
const HAIKU_INPUT_CENTS_PER_MTOKEN = 300;
const HAIKU_OUTPUT_CENTS_PER_MTOKEN = 1500;
const EST_SYSTEM_PROMPT_TOKENS = 13500;
const EST_OUTPUT_TOKENS_PER_CALL = 250;

const argv = process.argv.slice(2);
const gate = argv.includes('--gate');
const asJson = argv.includes('--json');

function resolveKey(): { key: string; source: string } | null {
  for (const source of ['ANTHROPIC_API_KEY', 'AI_PROVIDER_API_KEY'] as const) {
    const key = process.env[source]?.trim();
    if (key) return { key, source };
  }
  return null;
}

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

function projectRunCents(utterances: string[]): number {
  let cents = 0;
  for (const u of utterances) {
    const inputTokens = EST_SYSTEM_PROMPT_TOKENS + Math.ceil(u.length / 4);
    cents +=
      (inputTokens / 1_000_000) * HAIKU_INPUT_CENTS_PER_MTOKEN +
      (EST_OUTPUT_TOKENS_PER_CALL / 1_000_000) * HAIKU_OUTPUT_CENTS_PER_MTOKEN;
  }
  return cents;
}

async function main(): Promise<void> {
  const resolved = resolveKey();
  if (!resolved) {
    console.error(
      '❌ agent-path-smoke requires ANTHROPIC_API_KEY or AI_PROVIDER_API_KEY.\n' +
        '   This is a real-LLM gate — it never falls back to mocks.\n' +
        '   Exit 2 (no key).',
    );
    process.exit(2);
  }

  const utterances = allPathSmokeUtterances();
  const capCents = resolveCostCapCents();
  const projected = projectRunCents(utterances);
  const passRatio = resolvePassRatio();

  console.log(`\n🔥 Agent path smoke — REAL model`);
  console.log(`   key source:     ${resolved.source}`);
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

  const bus = new AgentEventBus();
  let spentCents = 0;
  const costTracker = {
    addCents(n: number) {
      spentCents += n;
    },
    totalCents() {
      return spentCents;
    },
  };

  const gateway = createRealLayerTwoGateway({
    apiKey: resolved.key,
    bus,
    costTracker,
  });

  const report = await runPathSmoke({
    gateway,
    passRatio,
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ...report,
          spentCents,
          projectedCents: projected,
          capCents,
          keySource: resolved.source,
        },
        null,
        2,
      ),
    );
  } else {
    for (const line of report.summaryLines) console.log(line);
    console.log(
      `\n   spent: ~${spentCents.toFixed(2)}¢ (projected ${projected.toFixed(1)}¢)`,
    );
  }

  const outPath = process.env.AGENT_PATH_SMOKE_OUT;
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          ...report,
          spentCents,
          projectedCents: projected,
          capCents,
          keySource: resolved.source,
        },
        null,
        2,
      ),
    );
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
