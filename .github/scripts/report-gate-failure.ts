/**
 * Plan 2026-09-05-001 U2 (R3) — make a red scheduled gate visible
 * without Slack by opening (and later closing) a GitHub issue.
 *
 * Run from CI as the LAST step of every scheduled gate, with
 * `if: always()` so it also runs on the green run that should close
 * the issue (an `if: failure()` step would never see that run):
 *
 *     npx tsx .github/scripts/report-gate-failure.ts
 *
 * Inputs (env, all required):
 *   - GITHUB_TOKEN       : `${{ secrets.GITHUB_TOKEN }}`; the workflow
 *                          must grant `permissions: issues: write`
 *   - GITHUB_REPOSITORY  : `<owner>/<repo>` (Actions sets this)
 *   - GATE_NAME          : `${{ github.workflow }}` — the issue title is
 *                          derived from it, so it is also the sticky key
 *   - JOB_STATUS         : `${{ job.status }}` — success | failure |
 *                          cancelled
 *   - RUN_URL            : link to the run, appended to every write
 *
 * Behaviour:
 *   - failure  : find the open issue titled `gate-red: <GATE_NAME>`
 *                labelled `gate-red`. Found → comment with the run URL.
 *                Not found → create it (label + run URL + what to do).
 *                If the create is rejected 422 because the `gate-red`
 *                label does not exist yet, the label is created and the
 *                create retried once — no manual repo setup needed.
 *   - success  : found → comment + close (`state_reason: completed`).
 *                Not found → no write at all.
 *   - cancelled: no write. A cancelled run is neither red nor green.
 *
 * Failure model — deliberately the opposite of
 * `voice-quality-trend-report.ts`'s swallow-everything `openRegressionIssue`:
 * any non-2xx GitHub response (or missing env) prints a clear
 * `[report-gate-failure]` error and exits 1. Because the step runs
 * with `if: always()` AFTER the gate's real steps, a red gate stays red
 * regardless, and a reporter that cannot reach GitHub turns a green run
 * red — which is the visibility this script exists to provide. Do not
 * add `continue-on-error` to its workflow step.
 *
 * Dependency-free: global `fetch` on Node 20, no octokit.
 */

export const GATE_RED_LABEL = 'gate-red';

const GITHUB_API_BASE = 'https://api.github.com';
const LOG_PREFIX = '[report-gate-failure]';

/** The sticky key: one open issue per gate, matched on exact title. */
export function gateIssueTitle(gateName: string): string {
  return `${GATE_RED_LABEL}: ${gateName}`;
}

type JobStatus = 'success' | 'failure' | 'cancelled';

function parseJobStatus(raw: string): JobStatus | null {
  return raw === 'success' || raw === 'failure' || raw === 'cancelled' ? raw : null;
}

interface GitHubIssue {
  number: number;
  title: string;
  /** Present when the "issue" is actually a pull request. */
  pull_request?: unknown;
}

interface GitHubClient {
  /** Performs one request; throws on any non-2xx response. */
  request(method: string, path: string, body?: unknown): Promise<Response>;
}

class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    statusText: string,
  ) {
    super(`GitHub API ${method} ${path} → ${status} ${statusText}`);
    this.name = 'GitHubApiError';
  }
}

function makeClient(opts: {
  fetchImpl: typeof fetch;
  apiBase: string;
  token: string;
}): GitHubClient {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${opts.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'serviceos-report-gate-failure',
  };
  return {
    async request(method, path, body) {
      const resp = await opts.fetchImpl(`${opts.apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!resp.ok) {
        throw new GitHubApiError(resp.status, method, path, resp.statusText);
      }
      return resp;
    },
  };
}

export interface ReportGateStatusOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  token: string;
  owner: string;
  repo: string;
  gateName: string;
  jobStatus: JobStatus;
  runUrl: string;
}

/**
 * Applies the gate's conclusion to the repo's `gate-red` issues. Throws
 * `GitHubApiError` on any non-2xx response; `run()` turns that into
 * exit code 1.
 */
export async function reportGateStatus(opts: ReportGateStatusOptions): Promise<void> {
  if (opts.jobStatus === 'cancelled') {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} job cancelled; leaving gate-red issues untouched`);
    return;
  }

  const client = makeClient({
    fetchImpl: opts.fetchImpl ?? fetch,
    apiBase: opts.apiBase ?? GITHUB_API_BASE,
    token: opts.token,
  });
  const repoPath = `/repos/${opts.owner}/${opts.repo}`;
  const title = gateIssueTitle(opts.gateName);

  // The issues endpoint also returns PRs, and the label filter is only
  // a narrowing — match on the exact title and drop PRs.
  const listResp = await client.request(
    'GET',
    `${repoPath}/issues?state=open&labels=${encodeURIComponent(GATE_RED_LABEL)}&per_page=100`,
  );
  const open = ((await listResp.json()) as GitHubIssue[]).find(
    (i) => i.title === title && !i.pull_request,
  );

  if (opts.jobStatus === 'failure') {
    if (open) {
      await client.request('POST', `${repoPath}/issues/${open.number}/comments`, {
        body: `Still red: ${opts.runUrl}`,
      });
      // eslint-disable-next-line no-console
      console.log(`${LOG_PREFIX} commented on open issue #${open.number}`);
      return;
    }
    const created = await createIssue(client, repoPath, {
      title,
      body: [
        `The scheduled gate **${opts.gateName}** is red.`,
        '',
        `Latest failing run: ${opts.runUrl}`,
        '',
        'This issue was opened automatically by `.github/scripts/report-gate-failure.ts`.',
        'Each further red run adds a comment here; the next green run closes it.',
        'Do not close it by hand while the gate is still failing — it will be reopened',
        'as a new issue on the next run. See docs/runbooks/alerting.md.',
      ].join('\n'),
      labels: [GATE_RED_LABEL],
    });
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} opened issue #${created.number}`);
    return;
  }

  // success
  if (!open) {
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} green and no open gate-red issue; nothing to do`);
    return;
  }
  await client.request('POST', `${repoPath}/issues/${open.number}/comments`, {
    body: `Green again: ${opts.runUrl}`,
  });
  await client.request('PATCH', `${repoPath}/issues/${open.number}`, {
    state: 'closed',
    state_reason: 'completed',
  });
  // eslint-disable-next-line no-console
  console.log(`${LOG_PREFIX} closed issue #${open.number}`);
}

async function createIssue(
  client: GitHubClient,
  repoPath: string,
  payload: { title: string; body: string; labels: string[] },
): Promise<{ number: number }> {
  try {
    const resp = await client.request('POST', `${repoPath}/issues`, payload);
    return (await resp.json()) as { number: number };
  } catch (err) {
    // 422 on create is how GitHub reports a label that does not exist in
    // the repo. Create it and retry exactly once; a second 422 propagates.
    if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
    // eslint-disable-next-line no-console
    console.log(`${LOG_PREFIX} issue create returned 422; creating label "${GATE_RED_LABEL}" and retrying`);
    await client.request('POST', `${repoPath}/labels`, {
      name: GATE_RED_LABEL,
      color: 'b60205',
      description: 'A scheduled CI gate is failing; closed automatically on the next green run',
    });
    const resp = await client.request('POST', `${repoPath}/issues`, payload);
    return (await resp.json()) as { number: number };
  }
}

interface RunOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Top-level entry point. Returns 0 on success (including the no-op
 * cases), 1 on missing/invalid env or any GitHub API failure.
 */
export async function run(opts: RunOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;

  const required = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GATE_NAME', 'JOB_STATUS', 'RUN_URL'] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`${LOG_PREFIX} missing required env: ${missing.join(', ')}`);
    return 1;
  }

  const repository = env.GITHUB_REPOSITORY!;
  const slash = repository.indexOf('/');
  if (slash <= 0 || slash === repository.length - 1) {
    // eslint-disable-next-line no-console
    console.error(`${LOG_PREFIX} GITHUB_REPOSITORY malformed (${repository}); expected <owner>/<repo>`);
    return 1;
  }

  const jobStatus = parseJobStatus(env.JOB_STATUS!);
  if (jobStatus === null) {
    // eslint-disable-next-line no-console
    console.error(
      `${LOG_PREFIX} JOB_STATUS must be success | failure | cancelled, got "${env.JOB_STATUS}"`,
    );
    return 1;
  }

  try {
    await reportGateStatus({
      fetchImpl: opts.fetchImpl,
      apiBase: opts.apiBase,
      token: env.GITHUB_TOKEN!,
      owner: repository.slice(0, slash),
      repo: repository.slice(slash + 1),
      gateName: env.GATE_NAME!,
      jobStatus,
      runUrl: env.RUN_URL!,
    });
  } catch (err) {
    // Loud and non-zero on purpose — see the failure model in the header.
    // eslint-disable-next-line no-console
    console.error(`${LOG_PREFIX} failed: ${(err as Error).message}`);
    return 1;
  }
  return 0;
}

// Run when invoked directly (not when imported by tests).
if (require.main === module) {
  void run().then((code) => {
    process.exit(code);
  });
}
