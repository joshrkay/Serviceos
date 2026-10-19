/**
 * CI contract tests for agent graph coverage + real-LLM path smoke.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { loadIntentTestSplit, loadSlotTranscripts } from '../../../voice-eval/corpus';
import { checkCostCap, sampleDeterministic } from '../../../voice-eval/live-support';
import {
  MAX_CAP_OVER_PROJECTION,
  effectiveCapCents,
  maxUtterances,
  stepBlock,
  workflowModel,
} from './ci-workflow-live-helpers';

const repoRoot = path.resolve(__dirname, '../../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/agent-path-smoke.yml');
const shimPath = path.join(repoRoot, '.github/workflows/agent-path-smoke-skip.yml');
const apiPackageJsonPath = path.resolve(__dirname, '../../package.json');
const prChecksPath = path.join(repoRoot, '.github/workflows/pr-checks.yml');

describe('agent-path-smoke.yml — real-LLM path smoke workflow', () => {
  it('exists and declares the path-smoke job', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/^name:\s*Agent Path Smoke/m);
    expect(src).toMatch(/path-smoke:/);
  });

  it('supports workflow_dispatch and pull_request (credential-gated)', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/workflow_dispatch:/);
    expect(src).toMatch(/pull_request:/);
  });

  it('runs agent-path-smoke with --gate and a cost cap', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    // Invoked via npm script: `npm run agent:path-smoke -- … --gate`
    expect(src).toMatch(/agent:path-smoke/);
    expect(src).toMatch(/--gate/);
    expect(src).toMatch(/AGENT_PATH_SMOKE_COST_CAP_CENTS:/);
  });

  it('exercises the production provider config (Railway prod/dev: OpenAI, gpt-4o-mini / gpt-4o)', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/AI_PROVIDER_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
    expect(src).toMatch(/AI_PROVIDER_BASE_URL:\s*'?https:\/\/api\.openai\.com\/v1'?/);
    expect(src).toMatch(/AI_DEFAULT_MODEL:\s*'?gpt-4o-mini'?/);
    expect(src).toMatch(/AI_LIGHTWEIGHT_MODEL:\s*'?gpt-4o-mini'?/);
    expect(src).toMatch(/AI_STANDARD_MODEL:\s*'?gpt-4o-mini'?/);
    expect(src).toMatch(/AI_COMPLEX_MODEL:\s*'?gpt-4o'?\s*$/m);
    // Anthropic is not the provider production uses — it must not be wired in
    // CI, or the script's fallback could silently test the wrong provider.
    expect(src).not.toMatch(/secrets\.ANTHROPIC_API_KEY/);
  });

  // OBS-3 — the smoke only ran for packages/api/src/ai/**, so a prompt edit in
  // reputation/, workers/transcription.ts or a tier change in
  // config/ai-routing.ts reached main with no real-model eval at all. Every
  // file that defines a system prompt or routes a model (grep of system
  // prompts and gateway.complete call sites) must start the real workflow.
  it('starts on every prompt-defining or model-routing file, not only src/ai/**', () => {
    const paths = yamlList(fs.readFileSync(workflowPath, 'utf-8'), 'paths');
    for (const required of [
      'packages/api/src/ai/**',
      'packages/api/src/reputation/**',
      'packages/api/src/verticals/**',
      'packages/api/src/workers/transcription.ts',
      'packages/api/src/workers/supervisor-review-worker.ts',
      'packages/api/src/workers/verify-ai.ts',
      'packages/api/src/proposals/edit-interpreter.ts',
      'packages/api/src/routes/assistant.ts',
      'packages/api/src/digest/weekly-feedback.ts',
      'packages/api/src/config/ai-routing.ts',
      'packages/voice-eval/**',
      '.github/workflows/agent-path-smoke.yml',
    ]) {
      expect(paths, `paths must include ${required}`).toContain(required);
    }
  });

  // The list above is a snapshot; this keeps it true. Any file under
  // packages/api/src that writes a system message, defines a prompt
  // constant or builder, or calls the model itself must sit under one of the
  // workflow's paths, or a prompt change there would skip the real-model
  // check again (OBS-3). Files that only pass a gateway through to a prompt
  // defined elsewhere are listed here with the reason.
  it('every file under packages/api/src that defines a prompt or calls the model is on the trigger list', () => {
    const wiringOnly: Record<string, string> = {
      // Passes llmGateway to prompts defined in ai/agents/customer-calling/*
      // and digest/weekly-feedback.ts (both on the list); changes on most PRs.
      'packages/api/src/app.ts': 'wires the gateway; prompts live in listed files',
      // Runs the graders in ai/voice-quality/graders/* (under ai/**).
      'packages/api/src/voice/quality/grade-voice-session.ts': 'wires the gateway; prompts live in listed files',
    };
    const paths = yamlList(fs.readFileSync(workflowPath, 'utf-8'), 'paths');
    const uncovered = promptDefiningFiles(path.join(repoRoot, 'packages/api/src')).filter(
      (file) => !paths.some((glob) => globCovers(glob, file)) && !(file in wiringOnly),
    );
    expect(uncovered, 'add these to agent-path-smoke.yml paths and the shim paths-ignore').toEqual([]);
    // An exemption for a file that no longer calls the model is stale.
    const defining = new Set(promptDefiningFiles(path.join(repoRoot, 'packages/api/src')));
    for (const file of Object.keys(wiringOnly)) expect(defining.has(file), `stale exemption ${file}`).toBe(true);
  });

  it('fails closed when AI_PROVIDER_API_KEY is absent', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/::error::AI_PROVIDER_API_KEY is not set/);
    expect(src).toMatch(/exit 1/);
    expect(src).not.toMatch(/has_key=false/);
    expect(src).not.toMatch(/steps\.check\.outputs\.has_key == 'true'/);
  });

  it('uploads the path-smoke report artifact', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/actions\/upload-artifact/);
    expect(src).toMatch(/agent-path-smoke-report/);
  });
});

// A system message, a prompt constant/builder, or a direct model call.
const PROMPT_MARKERS = [
  /role:\s*['"]system['"]\s*,\s*content/,
  /\b(?:const|function)\s+(?:[A-Z0-9_]*SYSTEM_PROMPT|(?:build|format|get)\w*Prompt(?:Section)?)\b\s*[=(:<]/,
  /\b(?:gateway|llmGateway|llm)\.complete\(/,
];

/** Repo-relative .ts files under `dir` whose code (comments stripped) carries a PROMPT_MARKERS hit. */
function promptDefiningFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...promptDefiningFiles(full));
    else if (entry.name.endsWith('.ts')) {
      const code = fs
        .readFileSync(full, 'utf-8')
        .split('\n')
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
        .join('\n');
      if (PROMPT_MARKERS.some((re) => re.test(code))) out.push(path.relative(repoRoot, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

/** The two glob shapes the workflow uses: `dir/**` and an exact file. */
function globCovers(glob: string, file: string): boolean {
  if (glob.endsWith('/**')) return file.startsWith(glob.slice(0, -2));
  expect(glob, `unsupported glob shape ${glob}`).not.toMatch(/[*?[]/);
  return glob === file;
}

/**
 * The quoted entries of the YAML list under `key:` (e.g. `paths:` or
 * `paths-ignore:`), read until the list dedents; comment lines inside the
 * list are skipped. Both workflows are written with one `- '...'` entry per
 * line, so no YAML parser is needed.
 */
function yamlList(src: string, key: string): string[] {
  const m = new RegExp(String.raw`^( *)${key}:\n((?:\1 +(?:#[^\n]*|- '[^']*')\n)+)`, 'm').exec(src);
  expect(m, `${key}: list not found`).not.toBeNull();
  return [...m![2].matchAll(/- '([^']*)'/g)].map((x) => x[1]);
}

// OBS-3 — the real-model smoke is the only PR check that calls the
// production model, and it is path-filtered. Branch protection can only
// require a check that reports on EVERY PR, so a sibling workflow with the
// same name and job id passes instantly on the PRs the filter skips
// (GitHub's documented pattern for a required, path-filtered check).
describe('agent-path-smoke-skip.yml — skip-pass shim for the required check', () => {
  it('reports the same check context (workflow name + job id) as the real workflow', () => {
    expect(fs.existsSync(shimPath)).toBe(true);
    const real = fs.readFileSync(workflowPath, 'utf-8');
    const shim = fs.readFileSync(shimPath, 'utf-8');
    const name = /^name:\s*(.+)$/m.exec(real)![1];
    expect(/^name:\s*(.+)$/m.exec(shim)![1]).toBe(name);
    expect(shim).toMatch(/^ {2}path-smoke:$/m);
    // The job id is the check context; a `name:` on the job would rename it.
    expect(shim).not.toMatch(/^ {4}name:/m);
    // The real job must not carry a display name either, or the two diverge.
    expect(real).not.toMatch(/^ {4}name:/m);
  });

  it('ignores exactly the paths the real workflow filters on, so the two can never both skip', () => {
    const real = fs.readFileSync(workflowPath, 'utf-8');
    const shim = fs.readFileSync(shimPath, 'utf-8');
    expect(shim).toMatch(/^on:\n {2}pull_request:\n {4}paths-ignore:/m);
    expect(yamlList(shim, 'paths-ignore')).toEqual(yamlList(real, 'paths'));
  });

  it('does nothing but pass: no model call, no secret, no install', () => {
    const shim = fs.readFileSync(shimPath, 'utf-8');
    expect(shim).not.toMatch(/secrets\./);
    expect(shim).not.toMatch(/npm ci|agent:path-smoke|--live/);
    expect(shim).toMatch(/permissions:\n {2}contents: read/);
  });
});

// OBS-3 — 11 classify utterances at a 0.8 pass ratio let two regressions
// through and say nothing about slot extraction. The recorded live baselines
// (intent 200 rows, slot 100 rows, 2026-09-30) already define the bar the
// weekly job measures; the PR job runs the same two evals so a prompt or
// routing change meets that bar BEFORE merge, not a week after.
describe('agent-path-smoke.yml — live intent + slot evals against the recorded baselines (OBS-3)', () => {
  function read(): string {
    return fs.readFileSync(workflowPath, 'utf-8');
  }

  it('runs both evals with --live --gate against the committed *-live.json baselines', () => {
    const src = read();
    expect(src).toMatch(
      /run-intent-eval\.ts --live --gate --max-utterances \d+ --baseline packages\/voice-eval\/baselines\/intent-live\.json/,
    );
    expect(src).toMatch(
      /run-slot-eval\.ts --live --gate --max-utterances \d+ --baseline packages\/voice-eval\/baselines\/slot-live\.json/,
    );
    // Never the record flag on a PR: a PR must be measured, not re-baselined.
    expect(src).not.toMatch(/--record-baseline/);
  });

  // applyBaselineGate fails the run (exit 1) when the sample's row count or
  // fingerprint differs from the recorded baseline, so a "cheaper" PR sample
  // would never pass. The sample must be exactly the recorded one.
  for (const [evalName, script] of [
    ['intent', 'run-intent-eval.ts --live'],
    ['slot', 'run-slot-eval.ts --live'],
  ] as const) {
    it(`the ${evalName} step classifies exactly the rows the recorded baseline covers`, () => {
      const step = stepBlock(read(), script);
      const baseline = JSON.parse(
        fs.readFileSync(path.join(repoRoot, `packages/voice-eval/baselines/${evalName}-live.json`), 'utf-8'),
      ) as { status: string; goldenSet: { rows: number } };
      expect(baseline.status).toBe('recorded');
      expect(maxUtterances(step)).toBe(baseline.goldenSet.rows);
    });
  }

  it('the slot step still runs (and reports) when the intent step failed', () => {
    const step = stepBlock(read(), 'run-slot-eval.ts --live');
    expect(step).toMatch(/if:\s*\$\{\{\s*!cancelled\(\)/);
  });

  it('the intent step projects within its cap, and the cap is sized for the workflow model', async () => {
    const src = read();
    const step = stepBlock(src, 'run-intent-eval.ts --live');
    const sample = sampleDeterministic(loadIntentTestSplit(), (r) => r.utterance, maxUtterances(step));
    const cap = effectiveCapCents(src, step);
    const cost = await checkCostCap(sample.map((r) => r.utterance), cap, await workflowModel(src));
    const msg = `cap ${cap}c vs projected ${cost.projectedCents?.toFixed(1)}c`;
    expect(cost.withinCap, msg).toBe(true);
    expect(cap, msg).toBeLessThanOrEqual(cost.projectedCents! * MAX_CAP_OVER_PROJECTION);
  });

  it('the slot step projects within its cap, and the cap is sized for the workflow model', async () => {
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

describe('npm scripts + PR graph coverage', () => {
  it('packages/api exposes agent:graph-coverage and agent:path-smoke scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(apiPackageJsonPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['agent:graph-coverage']).toMatch(/agent-graph-coverage\.ts/);
    expect(pkg.scripts['agent:path-smoke']).toMatch(/agent-path-smoke\.ts/);
  });

  it('pr-checks.yml runs offline graph coverage on every PR', () => {
    expect(fs.existsSync(prChecksPath)).toBe(true);
    const src = fs.readFileSync(prChecksPath, 'utf-8');
    expect(src).toMatch(/agent:graph-coverage/);
    expect(src).toMatch(/--gate/);
  });
});
