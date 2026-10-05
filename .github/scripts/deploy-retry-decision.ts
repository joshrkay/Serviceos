/**
 * #1631 — Deploy workflow runs are sometimes CANCELLED by GitHub's hosted
 * runner pool ("The job was not acquired by Runner of type hosted even
 * after multiple attempts"), not by a real failure and not by
 * `concurrency.cancel-in-progress` (already `false` for this workflow —
 * see `.github/workflows/deploy.yml`'s header comment). On 2026-10-05
 * this left three consecutive pushes to main undeployed with no alert
 * until a human ran `gh run rerun --failed` by hand.
 *
 * This is the pure decision + message logic for
 * `.github/workflows/deploy-retry.yml`'s `workflow_run` job, which
 * inspects a completed Deploy run's jobs (fetched by the workflow via
 * `gh api .../actions/runs/<id>/jobs`) and decides whether an automatic
 * `gh run rerun <id> --failed` is warranted.
 *
 * Retry only when:
 *   - at least one job concluded `cancelled`, AND
 *   - no job concluded `failure` (a real failure must never be silently
 *     retried — only a runner-availability cancellation should be), AND
 *   - `runAttempt < MAX_RUN_ATTEMPT` (cap at 2 automatic retries per
 *     run: attempt 1 cancelled -> retry to attempt 2; attempt 2
 *     cancelled -> retry to attempt 3; attempt 3 cancelled -> no further
 *     retry), AND
 *   - the run's commit is still the tip of main (a rerun redeploys that
 *     exact commit; never roll production back to an older one).
 *
 * Safety (deploy.yml header): `gh run rerun --failed` never resumes a
 * cancelled job's own process — a cancelled job never reached a
 * completed `railway up`, and GitHub starts the rerun attempt as a
 * FRESH job run, not a resumed one. Jobs that already succeeded (e.g.
 * `test`) are skipped by GitHub itself.
 *
 * Invoked from the workflow as:
 *
 *     npx tsx .github/scripts/deploy-retry-decision.ts
 *
 * with JOBS_JSON (the `jobs` array from
 * `gh api repos/{owner}/{repo}/actions/runs/{run_id}/jobs`, as a raw
 * JSON string), RUN_SHA / MAIN_SHA (the run's head sha and current main
 * tip), RUN_ATTEMPT (the run's `run_attempt`, as a string) and
 * RUN_URL (the run's `html_url`) in env. Prints a single-line JSON
 * object `{"retry":<bool>,"comment":<string>}` to stdout and exits 0;
 * exits 1 with a stderr message if the inputs are missing or malformed
 * (that failure must stop the workflow, not silently decide `false`).
 *
 * Dependency-free: no imports beyond Node builtins, same as
 * `report-gate-failure.ts`.
 */

export const MAX_RUN_ATTEMPT = 3;

export interface WorkflowJobConclusion {
  readonly name: string;
  readonly conclusion: string | null;
}

export interface DeployRetryDecisionInput {
  readonly jobs: readonly WorkflowJobConclusion[];
  readonly runAttempt: number;
  /** The commit the completed Deploy run was for. */
  readonly runSha: string;
  /** The current tip of main. */
  readonly mainSha: string;
}

/** True when the run should be retried — see the header for the rule. */
export function shouldRetryDeploy(input: DeployRetryDecisionInput): boolean {
  const hasCancelled = input.jobs.some((j) => j.conclusion === 'cancelled');
  const hasFailure = input.jobs.some((j) => j.conclusion === 'failure');
  // A rerun redeploys the run's own commit. If main has moved on, a rerun
  // could land an OLDER commit on top of a newer deploy; skip it (the
  // newer commit's own Deploy run is responsible for production).
  const isTip = input.runSha === input.mainSha;
  return hasCancelled && !hasFailure && isTip && input.runAttempt < MAX_RUN_ATTEMPT;
}

/** The commit-comment body posted when an automatic retry is triggered. */
export function buildRetryComment(opts: {
  readonly runUrl: string;
  readonly runAttempt: number;
}): string {
  return [
    'Deploy run was cancelled by the GitHub runner pool (not a real test/deploy failure) — automatically retrying.',
    '',
    `Run: ${opts.runUrl}`,
    `Attempt ${opts.runAttempt} -> ${opts.runAttempt + 1} (cap: ${MAX_RUN_ATTEMPT - 1} automatic retries per run).`,
    '',
    'See docs/runbooks/alerting.md#deploy-retry-cancelled-deploy-runs.',
  ].join('\n');
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}

const LOG_PREFIX = '[deploy-retry-decision]';

/**
 * Entry point: reads JOBS_JSON + RUN_ATTEMPT + RUN_URL from env, prints a
 * single-line JSON object `{"retry":<bool>,"comment":<string>}` to
 * stdout. Returns the process exit code (0 normally, 1 on
 * missing/malformed input).
 */
export function run(opts: RunOptions = {}): number {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((msg: string) => console.log(msg)); // eslint-disable-line no-console
  const error = opts.error ?? ((msg: string) => console.error(msg)); // eslint-disable-line no-console

  const required = ['JOBS_JSON', 'RUN_ATTEMPT', 'RUN_URL', 'RUN_SHA', 'MAIN_SHA'] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    error(`${LOG_PREFIX} missing required env: ${missing.join(', ')}`);
    return 1;
  }

  let jobs: WorkflowJobConclusion[];
  try {
    const parsed = JSON.parse(env.JOBS_JSON!);
    if (!Array.isArray(parsed)) {
      throw new Error('JOBS_JSON is not an array');
    }
    jobs = parsed as WorkflowJobConclusion[];
  } catch (err) {
    error(`${LOG_PREFIX} JOBS_JSON is not valid JSON: ${(err as Error).message}`);
    return 1;
  }

  const runAttempt = Number(env.RUN_ATTEMPT);
  if (!Number.isInteger(runAttempt) || runAttempt < 1) {
    error(`${LOG_PREFIX} RUN_ATTEMPT must be a positive integer, got "${env.RUN_ATTEMPT}"`);
    return 1;
  }

  const retry = shouldRetryDeploy({ jobs, runAttempt, runSha: env.RUN_SHA!, mainSha: env.MAIN_SHA! });
  const comment = retry ? buildRetryComment({ runUrl: env.RUN_URL!, runAttempt }) : '';
  log(JSON.stringify({ retry, comment }));
  return 0;
}

// Run when invoked directly (not when imported by tests).
if (require.main === module) {
  process.exit(run());
}
