/**
 * #839 — CI contract for the voice-eval baseline gate lanes, plus the
 * committed baseline files they compare against.
 *
 *   - PR Checks `voice-eval-gate`: offline (deterministic, free, fork-safe)
 *     intent + slot evals vs the committed offline baselines. PR-blocking.
 *   - Deploy `voice-quality-gate`: the same two comparisons on the deploy path.
 *   - voice-eval-live.yml: the live evals vs the committed LIVE baselines
 *     (placeholders until the owner records them — the gate fails closed).
 *
 * String assertions, same approach as ci-workflow-voice-eval-live.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readBaseline } from '../../../voice-eval/baseline';

const repoRoot = path.resolve(__dirname, '../../../..');
const wf = (name: string): string => fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf-8');
const baselinePath = (name: string): string => path.join(repoRoot, 'packages/voice-eval/baselines', name);

/** The body of a top-level job (from `  <job>:` to the next top-level job). */
function jobBlock(src: string, job: string): string {
  const start = src.indexOf(`\n  ${job}:\n`);
  expect(start, `job ${job} not found`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const OFFLINE_INTENT = /run-intent-eval\.ts --gate --baseline packages\/voice-eval\/baselines\/intent-offline\.json/;
const OFFLINE_SLOT = /run-slot-eval\.ts --gate --baseline packages\/voice-eval\/baselines\/slot-offline\.json/;

describe('pr-checks.yml — voice-eval-gate job', () => {
  it('runs both offline evals against the committed baselines', () => {
    const job = jobBlock(wf('pr-checks.yml'), 'voice-eval-gate');
    expect(job).toMatch(OFFLINE_INTENT);
    expect(job).toMatch(OFFLINE_SLOT);
  });

  it('needs no secrets and pins every action to a commit SHA', () => {
    const job = jobBlock(wf('pr-checks.yml'), 'voice-eval-gate');
    expect(job).not.toMatch(/secrets\./);
    const uses = [...job.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('deploy.yml — voice-quality-gate also enforces the eval baselines', () => {
  it('runs both offline baseline comparisons before any deploy', () => {
    const job = jobBlock(wf('deploy.yml'), 'voice-quality-gate');
    expect(job).toMatch(OFFLINE_INTENT);
    expect(job).toMatch(OFFLINE_SLOT);
  });
});

describe('voice-eval-live.yml — live runs compare against the live baselines', () => {
  it('passes the live baseline files to both live steps', () => {
    const src = wf('voice-eval-live.yml');
    expect(src).toMatch(/run-intent-eval\.ts --live[^\n]*packages\/voice-eval\/baselines\/intent-live\.json/);
    expect(src).toMatch(/run-slot-eval\.ts --live[^\n]*packages\/voice-eval\/baselines\/slot-live\.json/);
  });

  it('can record the live baselines from a manual dispatch and uploads them', () => {
    const src = wf('voice-eval-live.yml');
    expect(src).toMatch(/record_baseline:/);
    expect(src).toMatch(/--record-baseline/);
    expect(src).toMatch(/packages\/voice-eval\/baselines\/\*-live\.json/);
    // The dispatch input reaches the script through env, never inline ${{ }} in run:.
    expect(src).not.toMatch(/run:[^\n]*\$\{\{\s*inputs\./);
  });
});

describe('committed baselines', () => {
  it('offline baselines are recorded (deterministic, tolerance 0)', () => {
    for (const f of ['intent-offline.json', 'slot-offline.json']) {
      const b = readBaseline(baselinePath(f));
      expect(b.status, f).toBe('recorded');
      expect(b.mode, f).toBe('offline');
      expect(b.tolerance, f).toBe(0);
    }
  });

  it('live baselines parse and record at the SAME sample size the workflow runs', () => {
    const src = wf('voice-eval-live.yml');
    for (const [f, script] of [['intent-live.json', 'run-intent-eval.ts'], ['slot-live.json', 'run-slot-eval.ts']] as const) {
      const b = readBaseline(baselinePath(f));
      expect(b.mode, f).toBe('live');
      const wfN = new RegExp(`${script.replace('.', '\\.')} --live[^\\n]*--max-utterances (\\d+)`).exec(src)?.[1];
      const recN = /--max-utterances (\d+)/.exec(b.recordCommand)?.[1];
      expect(recN, `${f} record command sample`).toBe(wfN);
    }
  });
});
