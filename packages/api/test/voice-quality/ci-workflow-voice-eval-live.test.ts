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
  checkCostCap,
  sampleDeterministic,
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

  it('uses the required provider secret and a per-script cost cap', () => {
    const src = read();
    expect(src).toMatch(/ANTHROPIC_API_KEY:\s*\$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
    expect(src).not.toMatch(/OPENAI_API_KEY:\s*\$\{\{ secrets\.OPENAI_API_KEY \}\}/);
    expect(src).toMatch(/VOICE_EVAL_COST_CAP_CENTS:/);
  });

  it('fails closed when the key is absent', () => {
    const src = read();
    expect(src).toMatch(/::error::ANTHROPIC_API_KEY is not set/);
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

// #839 — the cap and the sample were configured independently, and the
// sample outgrew the cap: at the conservative preflight rate a 200-row
// intent run projects ~1,280c and a 100-row slot run ~640c, both over the
// workflow's 500c cap, so the moment ANTHROPIC_API_KEY was set every weekly
// run would have aborted with exit 3 before classifying anything. This pins
// the two together against the REAL golden set the runners load.
describe('voice-eval-live.yml — every configured live sample fits its cost cap (#839)', () => {
  it('the intent step projects within its cap', () => {
    const src = read();
    const step = stepBlock(src, 'run-intent-eval.ts --live');
    const sample = sampleDeterministic(loadIntentTestSplit(), (r) => r.utterance, maxUtterances(step));
    const cap = effectiveCapCents(src, step);
    const cost = checkCostCap(sample.map((r) => r.utterance), cap);
    expect(cost.withinCap, `projected ${cost.projectedCents.toFixed(1)}c > cap ${cap}c`).toBe(true);
  });

  it('the slot step projects within its cap', () => {
    const src = read();
    const step = stepBlock(src, 'run-slot-eval.ts --live');
    const sample = sampleDeterministic(loadSlotTranscripts(), (t) => t.transcript, maxUtterances(step));
    const cap = effectiveCapCents(src, step);
    const cost = checkCostCap(sample.map((t) => t.transcript), cap);
    expect(cost.withinCap, `projected ${cost.projectedCents.toFixed(1)}c > cap ${cap}c`).toBe(true);
  });
});
