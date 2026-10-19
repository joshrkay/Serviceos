/**
 * Shared readers for the workflow contract tests that pin a LIVE (real-model)
 * eval step to its cost cap and sample: voice-eval-live.yml (weekly) and
 * agent-path-smoke.yml (PR-time, OBS-3). Each step's cap must fit the sample
 * it classifies, priced at the model the workflow's own env selects.
 */
import { expect } from 'vitest';
import { DEFAULT_COST_CAP_CENTS, selectLiveProvider } from '../../../voice-eval/live-support';

/** The step block (text between its `- ` list markers) whose run line invokes `script`. */
export function stepBlock(src: string, script: string): string {
  const at = src.indexOf(script);
  expect(at, `${script} is not invoked by the workflow`).toBeGreaterThan(-1);
  const start = src.lastIndexOf('\n      - ', at);
  const next = src.indexOf('\n      - ', at);
  return src.slice(start, next === -1 ? undefined : next);
}

/** Effective VOICE_EVAL_COST_CAP_CENTS for a step: step env wins over job env. */
export function effectiveCapCents(src: string, step: string): number {
  const capRe = /VOICE_EVAL_COST_CAP_CENTS:\s*'?(\d+)'?/;
  const stepCap = capRe.exec(step);
  if (stepCap) return Number(stepCap[1]);
  const jobCap = capRe.exec(src.slice(0, src.indexOf('steps:')));
  return jobCap ? Number(jobCap[1]) : DEFAULT_COST_CAP_CENTS;
}

export function maxUtterances(step: string): number {
  const m = /--max-utterances[ =](\d+)/.exec(step);
  expect(m, 'live step must bound its sample with --max-utterances').not.toBeNull();
  return Number(m![1]);
}

/** The job-level env the workflow exports (the AI_* provider config). */
export function jobEnv(src: string): Record<string, string> {
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
export async function workflowModel(src: string): Promise<string> {
  const sel = await selectLiveProvider({ ...jobEnv(src), AI_PROVIDER_API_KEY: 'ci-secret' });
  expect(sel?.kind).toBe('production');
  return sel!.model;
}

// A cap more than this multiple of its projection is stale — sized for a
// pricier model (#1369's caps were sized for Haiku, ~20x gpt-4o-mini's
// rate) — and no longer bounds a runaway run tightly.
export const MAX_CAP_OVER_PROJECTION = 3;
