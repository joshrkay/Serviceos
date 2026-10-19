/**
 * CI contract tests for agent graph coverage + real-LLM path smoke.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { loadIntentTestSplit, loadSlotTranscripts } from '../../../voice-eval/corpus';
import { checkCostCap, sampleDeterministic } from '../../../voice-eval/live-support';
import { BASELINE_EXIT_NO_BASELINE, readBaseline } from '../../../voice-eval/baseline';
import { DRAFTING_GOLDEN_CASES, projectDraftingGoldenCents } from '../../src/ai/voice-quality/drafting-golden';
import {
  MAX_CAP_OVER_PROJECTION,
  effectiveCapCents,
  jobEnv,
  maxUtterances,
  stepBlock,
  workflowModel,
} from './ci-workflow-live-helpers';

const repoRoot = path.resolve(__dirname, '../../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/agent-path-smoke.yml');
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
    const paths = pathSmokePaths(fs.readFileSync(workflowPath, 'utf-8'));
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
      'packages/api/scripts/drafting-golden-eval.ts',
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
    const paths = pathSmokePaths(fs.readFileSync(workflowPath, 'utf-8'));
    const uncovered = promptDefiningFiles(path.join(repoRoot, 'packages/api/src')).filter(
      (file) => !paths.some((glob) => globCovers(glob, file)) && !(file in wiringOnly),
    );
    expect(uncovered, 'add these to PATH_SMOKE_PATHS in agent-path-smoke.yml').toEqual([]);
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
 * The globs in the `changes` job's PATH_SMOKE_PATHS literal block — the ONE
 * list that decides whether a pull request runs the real-model evals. One
 * glob per line, read until the block dedents.
 */
function pathSmokePaths(src: string): string[] {
  const m = /^( *)PATH_SMOKE_PATHS: \|\n((?:\1 {2}[^\n]+\n)+)/m.exec(src);
  expect(m, 'PATH_SMOKE_PATHS: | block not found').not.toBeNull();
  return m![2].split('\n').map((l) => l.trim()).filter(Boolean);
}

/** The `run: |` script of the step whose `id:` is `id`, de-indented. */
function stepScript(src: string, id: string): string {
  const at = src.indexOf(`id: ${id}\n`);
  expect(at, `step id ${id} not found`).toBeGreaterThan(-1);
  const m = /\n( *)run: \|\n((?:\1 {2}[^\n]*\n|\n)+)/.exec(src.slice(at));
  expect(m, `step ${id} has no run: | script`).not.toBeNull();
  const indent = m![1].length + 2;
  return m![2]
    .split('\n')
    .map((l) => l.slice(indent))
    .join('\n');
}

/** The text of top-level job `id` (from its header to the next job or EOF). */
function jobBlock(src: string, id: string): string {
  const at = src.search(new RegExp(`^ {2}${id}:$`, 'm'));
  expect(at, `job ${id} not found`).toBeGreaterThan(-1);
  const rest = src.slice(at + 1);
  const next = rest.search(/^ {2}[a-z][a-z0-9-]*:$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

// OBS-3 review round 1 — the old skip-pass shim was a SECOND workflow
// reporting a `path-smoke` check run on the complement of the paths. Every
// real prompt PR also touches a test file, so both workflows ran, the shim's
// instant green raced the real eval, and which one branch protection honoured
// was undocumented. Now ONE workflow runs on every pull request; a `changes`
// job decides, and `path-smoke` is skipped by a job-level conditional when no
// listed file changed — GitHub's documented "skipped job reports success"
// behaviour — so there is exactly one `path-smoke` check run per PR.
describe('agent-path-smoke.yml — one path-smoke check run per pull request', () => {
  const read = (): string => fs.readFileSync(workflowPath, 'utf-8');

  // One test on purpose (OBS-3 review round 3): the shim-absence half alone
  // also held on main, which never had a shim, so it did not guard the
  // trigger. Together they pin the one shape that works — a single workflow
  // that starts on every pull request and decides in its own `changes` job.
  it('runs on every pull request as the only Agent Path Smoke workflow: no paths filter, no skip-pass shim', () => {
    const on = /^on:\n((?: {2}[^\n]*\n|\n)+)/m.exec(read())![1];
    expect(on).toMatch(/^ {2}pull_request:\s*$/m);
    expect(on).not.toMatch(/paths(-ignore)?:/);
    expect(fs.existsSync(path.join(repoRoot, '.github/workflows/agent-path-smoke-skip.yml'))).toBe(false);
    for (const f of fs.readdirSync(path.join(repoRoot, '.github/workflows'))) {
      if (f === 'agent-path-smoke.yml') continue;
      const other = fs.readFileSync(path.join(repoRoot, '.github/workflows', f), 'utf-8');
      expect(/^name:\s*Agent Path Smoke\s*$/m.test(other), `${f} reuses the Agent Path Smoke name`).toBe(false);
    }
  });

  // OBS-3 review round 3 — the skip decision diffs the PR against the base it
  // had when the run started, and the check attaches to the head SHA. The
  // default pull_request types (opened, synchronize, reopened) do not include
  // a base-branch change (`edited`), so a stacked PR that skipped against its
  // parent branch kept that green after being retargeted to main and merged
  // the parent's prompt edit with no real-model eval. `edited` must re-run
  // the diff against the new base — unfiltered: a skip on a title edit would
  // post a fresh skip-as-success over an earlier red.
  it('re-runs when the pull request is edited, so a base-branch change is diffed against the new base', () => {
    const on = /^on:\n((?: {2}[^\n]*\n|\n)+)/m.exec(read())![1];
    const types = /^ {2}pull_request:\s*\n {4}types:\s*\[([^\]]*)\]/m.exec(on);
    expect(types, 'pull_request must list its activity types').not.toBeNull();
    expect(new Set(types![1].split(',').map((t) => t.trim()))).toEqual(
      new Set(['opened', 'synchronize', 'reopened', 'edited']),
    );
  });

  it('path-smoke needs the changes job and is skipped only when it says no listed file changed', () => {
    const job = jobBlock(read(), 'path-smoke');
    expect(job).toMatch(/^ {4}needs: changes$/m);
    // Fail closed: a failed or skipped `changes` job leaves the output empty,
    // and empty is not 'false', so the real evals still run.
    expect(job).toContain(
      "if: ${{ !cancelled() && (github.event_name != 'pull_request' || needs.changes.outputs.match != 'false') }}",
    );
    // The job id is the check context; a display name would rename it.
    expect(job).not.toMatch(/^ {4}name:/m);
  });

  it('the changes job exports match from its diff step and fetches the merge commit\'s parents', () => {
    const job = jobBlock(read(), 'changes');
    expect(job).toContain('match: ${{ steps.diff.outputs.match }}');
    expect(job).toMatch(/fetch-depth: 2/);
    expect(job).not.toMatch(/secrets\./);
  });

  describe('the changes step, executed against a real pull-request merge commit', () => {
    function repoWithPr(changedOnPr: string[]): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-smoke-changes-'));
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'pipe' });
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'pr');
      for (const f of changedOnPr) {
        fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), 'changed\n');
      }
      git('add', '.');
      git('commit', '-q', '-m', 'pr');
      git('checkout', '-q', 'main');
      // What actions/checkout gives a pull_request run: the merge commit,
      // parent 1 = base tip, parent 2 = PR head.
      git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
      return dir;
    }

    function runChanges(cwd: string, eventName = 'pull_request'): string {
      const src = read();
      const out = path.join(cwd, 'gh-output');
      fs.writeFileSync(out, '');
      execFileSync('bash', ['-e', '-c', stepScript(src, 'diff')], {
        cwd,
        stdio: 'pipe',
        env: {
          ...process.env,
          EVENT_NAME: eventName,
          PATH_SMOKE_PATHS: pathSmokePaths(src).join('\n') + '\n',
          GITHUB_OUTPUT: out,
        },
      });
      return fs.readFileSync(out, 'utf-8');
    }

    it('a prompt edit plus its test (the normal mixed PR) runs the real evals', () => {
      const dir = repoWithPr([
        'packages/api/src/reputation/draft-public-response.ts',
        'packages/api/test/reputation/draft-public-response.test.ts',
      ]);
      expect(runChanges(dir)).toBe('match=true\n');
    });

    it('an exact-file entry matches (workers/transcription.ts)', () => {
      expect(runChanges(repoWithPr(['packages/api/src/workers/transcription.ts']))).toBe('match=true\n');
    });

    it('a PR touching no listed file skips them', () => {
      const dir = repoWithPr(['packages/web/src/App.tsx', 'packages/api/src/routes/invoices.ts']);
      expect(runChanges(dir)).toBe('match=false\n');
    });

    it('fails closed: when the merge commit is not there to diff, the evals run', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-smoke-changes-'));
      execFileSync('git', ['init', '-q'], { cwd: dir });
      expect(runChanges(dir)).toBe('match=true\n');
    });

    it('schedule and manual runs always run the evals', () => {
      expect(runChanges(repoWithPr(['packages/web/src/App.tsx']), 'schedule')).toBe('match=true\n');
    });
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

// OBS-3 review round 1 — the classifier evals said nothing about the
// drafting prompts: a change to draft_estimate, brand voice or the review
// reply prompt merged with no real-model result. The drafting golden set runs
// in the same job, through the production task code, gated on its safety
// checks and the recorded live baseline.
describe('agent-path-smoke.yml — live drafting golden set (draft_estimate, brand voice, review reply)', () => {
  const read = (): string => fs.readFileSync(workflowPath, 'utf-8');
  const script = 'drafting-golden-eval.ts --live';

  it('runs with --live --gate against the committed drafting-live.json baseline', () => {
    const step = stepBlock(read(), script);
    expect(step).toMatch(
      /npx tsx packages\/api\/scripts\/drafting-golden-eval\.ts --live --gate --baseline packages\/voice-eval\/baselines\/drafting-live\.json/,
    );
    expect(step).not.toMatch(/--record-baseline/);
  });

  it('runs (and reports) even when an earlier eval failed, but only with deps and a key', () => {
    const step = stepBlock(read(), script);
    expect(step).toContain(
      "if: ${{ !cancelled() && steps.install.outcome == 'success' && steps.key.outcome == 'success' }}",
    );
  });

  // OBS-3 review round 2 — the brand_voice_v1 composer writes the customer
  // SMS (tech reschedule, dropped-call recovery) and the digest narrative;
  // update_brand_voice only turns a spoken instruction into config. Both
  // must be in the set this step runs, or a composer prompt edit merges green.
  it('the golden set this step runs calls every drafting task, including the brand_voice_v1 composer', () => {
    expect(new Set(DRAFTING_GOLDEN_CASES.map((c) => c.task))).toEqual(
      new Set(['draft_estimate', 'update_brand_voice', 'review_public_response', 'brand_voice_v1']),
    );
    const composerIntents = new Set(
      DRAFTING_GOLDEN_CASES.flatMap((c) => (c.task === 'brand_voice_v1' ? [c.intent] : [])),
    );
    expect(composerIntents).toEqual(new Set(['dropped_call_recovery_sms', 'tech_reschedule_customer_sms']));
    expect(DRAFTING_GOLDEN_CASES.some((c) => c.task === 'brand_voice_v1' && (c.injected ?? []).length > 0)).toBe(true);
  });

  it('its cost cap fits the projection at the costliest model the workflow configures', () => {
    const src = read();
    const step = stepBlock(src, script);
    const cap = effectiveCapCents(src, step);
    const projected = projectDraftingGoldenCents(jobEnv(src).AI_COMPLEX_MODEL)!;
    const msg = `cap ${cap}c vs projected ${projected.toFixed(1)}c`;
    expect(projected, msg).toBeGreaterThan(0);
    expect(projected, msg).toBeLessThanOrEqual(cap);
    expect(cap, msg).toBeLessThanOrEqual(projected * MAX_CAP_OVER_PROJECTION);
  });

  // OBS-3 review round 3 — drafting-live.json ships as an unrecorded
  // placeholder (recording needs a paid run with the OpenAI key). Failing
  // closed on it (exit 4) turned every AI pull request, the daily run and
  // this PR red whatever they changed, and a check that is always red gets
  // waved through — intent and slot regressions with it. Until it is
  // recorded, exit 4 is a visible warning; a safety violation (exit 1), a
  // quality regression against a recorded baseline (1), a cost abort (3)
  // and a missing key (2) still fail the step. Executes the step's own
  // script with the eval runner stubbed to exit with each code.
  describe('the step, executed with the eval runner exiting each code', () => {
    function runStep(runnerExit: number): { status: number; stdout: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-smoke-drafting-'));
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'npx'), `#!/usr/bin/env bash\necho "runner $*"\nexit ${runnerExit}\n`, { mode: 0o755 });
      const res = spawnSync('bash', ['-e', '-c', stepScript(read(), 'drafting')], {
        cwd: dir,
        encoding: 'utf-8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(fs.readFileSync(path.join(dir, 'agent-path-smoke-console.txt'), 'utf-8')).toMatch(
        /^runner tsx packages\/api\/scripts\/drafting-golden-eval\.ts --live --gate --baseline /,
      );
      return { status: res.status ?? -1, stdout: res.stdout };
    }

    it('an unrecorded placeholder baseline (exit 4) passes with a warning naming the file to record', () => {
      const { status, stdout } = runStep(BASELINE_EXIT_NO_BASELINE);
      expect(status).toBe(0);
      expect(stdout).toMatch(/^::warning::.*packages\/voice-eval\/baselines\/drafting-live\.json/m);
    });

    it.each([
      [1, 'a safety violation or a regression past the recorded baseline'],
      [2, 'no key'],
      [3, 'a cost-cap abort'],
    ])('exit %i (%s) still fails the step', (code) => {
      const { status, stdout } = runStep(code);
      expect(status).toBe(code);
      expect(stdout).not.toMatch(/::warning::/);
    });

    it('a pass (exit 0) passes without a warning', () => {
      const { status, stdout } = runStep(0);
      expect(status).toBe(0);
      expect(stdout).not.toMatch(/::warning::/);
    });
  });

  it('the committed baseline is a live drafting baseline whose record command uses the same runner', () => {
    const b = readBaseline(path.join(repoRoot, 'packages/voice-eval/baselines/drafting-live.json'));
    expect(b.eval).toBe('drafting');
    expect(b.mode).toBe('live');
    expect(b.recordCommand).toMatch(
      /drafting-golden-eval\.ts --live --record-baseline packages\/voice-eval\/baselines\/drafting-live\.json/,
    );
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
