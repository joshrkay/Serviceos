/**
 * CI workflow contract test for the LIVE voice-eval pipeline
 * (.github/workflows/voice-eval-live.yml).
 *
 * Same lightweight string-assertion approach as ci-workflow-layer2*.test.ts —
 * GitHub Actions is the source of truth for YAML structural validity; this pins
 * the contract the rollout depends on (triggers, gating, secrets, cost caps,
 * fork safety, artifact upload) so an accidental edit is caught in PR CI.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadIntentTestSplit, loadSlotTranscripts } from '../../../voice-eval/corpus';
import {
  DEFAULT_COST_CAP_CENTS,
  LIVE_RECORD_COMMANDS,
  checkCostCap,
  sampleDeterministic,
  selectLiveProvider,
} from '../../../voice-eval/live-support';

const repoRoot = path.resolve(__dirname, '../../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/voice-eval-live.yml');

function read(): string {
  return fs.readFileSync(workflowPath, 'utf-8');
}

describe('voice-eval-live.yml — scheduled live eval workflow', () => {
  it('exists and declares the live-eval job', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const src = read();
    expect(src).toMatch(/^name:\s*Voice Eval Live/m);
    expect(src).toMatch(/live-eval:/);
  });

  it('triggers on a weekly cron + manual dispatch (NOT on pull_request)', () => {
    const src = read();
    expect(src).toMatch(/workflow_dispatch:/);
    expect(src).toMatch(/cron:\s*'0 7 \* \* 1'/);
    // No pull_request TRIGGER (the word may appear in explanatory comments).
    expect(src).not.toMatch(/^\s*pull_request:/m);
  });

  it('runs both evals with --live --gate and bounded sampling', () => {
    const src = read();
    expect(src).toMatch(/run-intent-eval\.ts --live --gate --max-utterances \d+/);
    expect(src).toMatch(/run-slot-eval\.ts --live --gate --max-utterances \d+/);
  });

  // Production (Railway prod/dev) runs the OpenAI-compatible gateway with
  // gpt-4o-mini (default/lightweight/standard) and gpt-4o (complex). The live
  // eval must measure THAT provider — the Anthropic account behind
  // secrets.ANTHROPIC_API_KEY has no credit and production never calls it.
  it('exercises the production provider config (OpenAI, gpt-4o-mini / gpt-4o), not Anthropic', () => {
    const src = read();
    expect(src).toMatch(/AI_PROVIDER_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
    expect(src).toMatch(/AI_PROVIDER_BASE_URL:\s*'?https:\/\/api\.openai\.com\/v1'?/);
    expect(src).toMatch(/AI_DEFAULT_MODEL:\s*'?gpt-4o-mini'?/);
    expect(src).toMatch(/AI_LIGHTWEIGHT_MODEL:\s*'?gpt-4o-mini'?/);
    expect(src).toMatch(/AI_STANDARD_MODEL:\s*'?gpt-4o-mini'?/);
    expect(src).toMatch(/AI_COMPLEX_MODEL:\s*'?gpt-4o'?\s*$/m);
    // Production classify deadline (docs/runbooks/live-ai-restore.md).
    expect(src).toMatch(/AI_CLASSIFY_INTENT_DEADLINE_MS:\s*'12000'/);
    expect(src).not.toMatch(/secrets\.ANTHROPIC_API_KEY/);
    expect(src).toMatch(/VOICE_EVAL_COST_CAP_CENTS:/);
  });

  it('fails closed when AI_PROVIDER_API_KEY is absent', () => {
    const src = read();
    expect(src).toMatch(/::error::AI_PROVIDER_API_KEY is not set/);
    expect(src).toMatch(/exit 1/);
    expect(src).not.toMatch(/has_key=false/);
  });

  it('uploads the eval report as an artifact even on failure', () => {
    const src = read();
    expect(src).toMatch(/actions\/upload-artifact/);
    expect(src).toMatch(/voice-eval-live-report/);
    expect(src).toMatch(/if:\s*always\(\)/);
  });

  it('needs no Postgres/Docker/ffmpeg STEPS (classifier + gateway need no DB)', () => {
    const src = read();
    // Assert on actual step/service patterns, not comment prose.
    expect(src).not.toMatch(/^\s*services:/m);
    expect(src).not.toMatch(/docker pull|pgvector\/pgvector/);
    expect(src).not.toMatch(/apt-get install[^\n]*ffmpeg/);
  });
});

/** The step block (text between its `- ` list markers) whose run line invokes `script`. */
function stepBlock(src: string, script: string): string {
  const at = src.indexOf(script);
  expect(at, `${script} is not invoked by the workflow`).toBeGreaterThan(-1);
  const start = src.lastIndexOf('\n      - ', at);
  const next = src.indexOf('\n      - ', at);
  return src.slice(start, next === -1 ? undefined : next);
}

/** Effective VOICE_EVAL_COST_CAP_CENTS for a step: step env wins over job env. */
function effectiveCapCents(src: string, step: string): number {
  const capRe = /VOICE_EVAL_COST_CAP_CENTS:\s*'?(\d+)'?/;
  const stepCap = capRe.exec(step);
  if (stepCap) return Number(stepCap[1]);
  const jobCap = capRe.exec(src.slice(0, src.indexOf('steps:')));
  return jobCap ? Number(jobCap[1]) : DEFAULT_COST_CAP_CENTS;
}

function maxUtterances(step: string): number {
  const m = /--max-utterances[ =](\d+)/.exec(step);
  expect(m, 'live step must bound its sample with --max-utterances').not.toBeNull();
  return Number(m![1]);
}

/** The job-level env the workflow exports (the AI_* provider config). */
function jobEnv(src: string): Record<string, string> {
  const head = src.slice(src.indexOf('\n    env:'), src.indexOf('\n    steps:'));
  const env: Record<string, string> = {};
  for (const m of head.matchAll(/^ {6}([A-Z0-9_]+):\s*'?([^'\n#]*?)'?\s*$/gm)) env[m[1]] = m[2];
  return env;
}

/**
 * The model the runners will classify with — resolved by the SAME selector the
 * runners use, from the workflow's own env (a dummy key stands in for the
 * `${{ secrets.OPENAI_API_KEY }}` expression).
 */
async function workflowModel(src: string): Promise<string> {
  const sel = await selectLiveProvider({ ...jobEnv(src), AI_PROVIDER_API_KEY: 'ci-secret' });
  expect(sel?.kind).toBe('production');
  return sel!.model;
}

// A cap more than this multiple of its projection is stale — sized for a
// pricier model (#1369's caps were sized for Haiku, ~20x gpt-4o-mini's
// rate) — and no longer bounds a runaway run tightly.
const MAX_CAP_OVER_PROJECTION = 3;

// #839 — the cap and the sample were configured independently, and the
// sample outgrew the cap. This pins the two together against the REAL golden
// set the runners load, priced at the model the workflow actually selects.
describe('voice-eval-live.yml — every configured live sample fits its cost cap (#839)', () => {
  it('the workflow classifies with gpt-4o-mini (the production classify tier)', async () => {
    expect(await workflowModel(read())).toBe('gpt-4o-mini');
  });

  it('the intent step projects within its cap, and the cap is sized for that model', async () => {
    const src = read();
    const step = stepBlock(src, 'run-intent-eval.ts --live');
    const sample = sampleDeterministic(loadIntentTestSplit(), (r) => r.utterance, maxUtterances(step));
    const cap = effectiveCapCents(src, step);
    const cost = await checkCostCap(sample.map((r) => r.utterance), cap, await workflowModel(src));
    const msg = `cap ${cap}c vs projected ${cost.projectedCents?.toFixed(1)}c`;
    expect(cost.withinCap, msg).toBe(true);
    expect(cap, msg).toBeLessThanOrEqual(cost.projectedCents! * MAX_CAP_OVER_PROJECTION);
  });

  it('the slot step projects within its cap, and the cap is sized for that model', async () => {
    const src = read();
    const step = stepBlock(src, 'run-slot-eval.ts --live');
    const sample = sampleDeterministic(loadSlotTranscripts(), (t) => t.transcript, maxUtterances(step));
    const cap = effectiveCapCents(src, step);
    const cost = await checkCostCap(sample.map((t) => t.transcript), cap, await workflowModel(src));
    const msg = `cap ${cap}c vs projected ${cost.projectedCents?.toFixed(1)}c`;
    expect(cost.withinCap, msg).toBe(true);
    expect(cap, msg).toBeLessThanOrEqual(cost.projectedCents! * MAX_CAP_OVER_PROJECTION);
  });
});

// The placeholder baselines tell the owner how to record them, and
// writeBaseline carries a placeholder's recordCommand forward into the
// recorded file — so it must describe the provider, cap and sample the
// workflow actually runs.
describe('live baselines — recordCommand matches the workflow (#839)', () => {
  for (const [evalName, script] of [
    ['intent', 'run-intent-eval.ts --live'],
    ['slot', 'run-slot-eval.ts --live'],
  ] as const) {
    it(`${evalName}-live.json records with the production provider and the step's cap + sample`, () => {
      const src = read();
      const step = stepBlock(src, script);
      const baseline = JSON.parse(
        fs.readFileSync(path.join(repoRoot, `packages/voice-eval/baselines/${evalName}-live.json`), 'utf-8'),
      ) as { recordCommand: string };
      const cmd = baseline.recordCommand;
      expect(cmd).toBe(LIVE_RECORD_COMMANDS[evalName]);
      expect(cmd).toMatch(/^AI_PROVIDER_API_KEY=\S+ AI_PROVIDER_BASE_URL=https:\/\/api\.openai\.com\/v1 /);
      expect(cmd).toContain('AI_DEFAULT_MODEL=gpt-4o-mini');
      expect(cmd).not.toContain('ANTHROPIC_API_KEY');
      expect(cmd).toContain(`VOICE_EVAL_COST_CAP_CENTS=${effectiveCapCents(src, step)} `);
      expect(cmd).toContain(`--max-utterances ${maxUtterances(step)} `);
    });
  }
});
