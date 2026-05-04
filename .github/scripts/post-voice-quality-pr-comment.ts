/**
 * VQ-025 — Post (or update) a sticky PR comment with the voice-quality
 * report.
 *
 * Run from CI as the final step of the `voice-quality` job:
 *
 *     npx ts-node .github/scripts/post-voice-quality-pr-comment.ts
 *
 * Inputs (env):
 *   - GITHUB_TOKEN      : token with `pull-requests: write`
 *   - GITHUB_REPOSITORY : `<owner>/<repo>` (Actions sets this)
 *   - GITHUB_REF        : `refs/pull/<n>/merge` on PR runs
 *   - REPORT_PATH       : path to the JSON report (defaults to
 *                         `packages/api/voice-quality-report.json`)
 *
 * The "sticky comment" pattern: every run finds an existing comment by
 * scanning for a hidden HTML marker (`STICKY_MARKER`) in the comment
 * body. If found, we PATCH; otherwise POST. This avoids the comment-
 * spam problem (one comment per PR, regardless of run count).
 *
 * Failure-tolerance: this script is invoked with `if: always()` from
 * the workflow, and the upstream voice-quality job uses
 * `continue-on-error: true`. We must therefore handle the case where
 * the report JSON does not exist (the test runner crashed before
 * writing it) — we post a clearly-labelled fallback comment so the
 * PR author still has a signal, and exit 0 to keep CI green-ish.
 *
 * No external runtime deps: we use Node 20's built-in `fetch` and the
 * `formatReportMarkdown` helper from the API package via a relative
 * import. Tests mock the fetch implementation by passing
 * `{ fetchImpl }` to `postOrUpdateComment` / `run`, keeping the script
 * hermetic.
 */
import * as fs from 'fs';
import * as path from 'path';

import { formatReportMarkdown } from '../../packages/api/src/ai/voice-quality/graders/report';
import type { VoiceQualityReport } from '../../packages/api/src/ai/voice-quality/graders/report';

/** HTML-comment marker used to identify the sticky comment on PRs. */
export const STICKY_MARKER = '<!-- voice-quality-report -->';

/** GitHub REST API base URL (overridable for tests). */
const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Extract the PR number from `GITHUB_REF`. Returns null when the ref
 * isn't a PR ref (e.g., push to main, manual run on a branch).
 *
 * Examples:
 *   - `refs/pull/265/merge` → 265
 *   - `refs/pull/1/head`    → 1
 *   - `refs/heads/main`     → null
 */
export function extractPrNumber(ref: string | undefined | null): number | null {
  if (!ref) return null;
  const m = ref.match(/^refs\/pull\/(\d+)\/(merge|head)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Read the report JSON from disk. Returns null when the file is
 * missing or unreadable. We deliberately swallow parse errors here
 * (logging a warning) so the caller can post the fallback message.
 */
export function loadReport(reportPath: string): VoiceQualityReport | null {
  try {
    if (!fs.existsSync(reportPath)) {
      return null;
    }
    const raw = fs.readFileSync(reportPath, 'utf-8');
    return JSON.parse(raw) as VoiceQualityReport;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[post-voice-quality-pr-comment] failed to read report at ${reportPath}: ${
        (err as Error).message
      }`,
    );
    return null;
  }
}

/**
 * Build the sticky-comment body. The first line is always the marker
 * (so the next run can find this comment). When the report is null,
 * we emit a fallback message — this happens when the upstream job
 * crashed before writing the artifact.
 */
export function buildCommentBody(report: VoiceQualityReport | null): string {
  if (report === null) {
    return [
      STICKY_MARKER,
      '',
      '# Voice Quality Report',
      '',
      '_Voice quality run did not produce a report — see job logs._',
    ].join('\n');
  }
  return `${STICKY_MARKER}\n\n${formatReportMarkdown(report)}`;
}

/** Minimal shape we care about from the GitHub Issues comments API. */
interface IssueComment {
  id: number;
  body?: string;
}

interface PostOrUpdateOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  body: string;
}

/**
 * Post a new sticky comment, or update the existing one if a comment
 * carrying `STICKY_MARKER` is already present on the PR.
 *
 * The list endpoint paginates; for our use case (a few dozen
 * comments at most) the default page size of 30 is fine. If a repo
 * ever exceeds that, the worst case is we post a duplicate sticky —
 * not a correctness bug, just a small UX regression. Pagination can
 * be added then.
 */
export async function postOrUpdateComment(
  opts: PostOrUpdateOptions,
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? GITHUB_API_BASE;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${opts.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'serviceos-voice-quality-pr-comment',
  };

  const listUrl = `${apiBase}/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/comments?per_page=100`;
  const listResp = await fetchImpl(listUrl, { method: 'GET', headers });
  if (!listResp.ok) {
    throw new Error(
      `failed to list PR comments: ${listResp.status} ${listResp.statusText}`,
    );
  }
  const existing = (await listResp.json()) as IssueComment[];
  const sticky = existing.find((c) => (c.body ?? '').includes(STICKY_MARKER));

  if (sticky) {
    const patchUrl = `${apiBase}/repos/${opts.owner}/${opts.repo}/issues/comments/${sticky.id}`;
    const resp = await fetchImpl(patchUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body: opts.body }),
    });
    if (!resp.ok) {
      throw new Error(
        `failed to update sticky comment ${sticky.id}: ${resp.status} ${resp.statusText}`,
      );
    }
  } else {
    const postUrl = `${apiBase}/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/comments`;
    const resp = await fetchImpl(postUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: opts.body }),
    });
    if (!resp.ok) {
      throw new Error(
        `failed to post new sticky comment: ${resp.status} ${resp.statusText}`,
      );
    }
  }
}

interface RunOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Top-level entry point. Returns an exit code (0 on success or
 * graceful no-op, non-zero on hard failure).
 *
 * No-op cases (return 0 without posting):
 *   - GITHUB_REF doesn't look like a PR ref (push to main, etc.)
 *   - GITHUB_TOKEN is missing
 *   - GITHUB_REPOSITORY is missing or malformed
 *
 * The fallback "did not produce a report" comment IS posted when the
 * report is missing, on the assumption the run was a PR run that
 * crashed.
 */
export async function run(opts: RunOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;

  const ref = env.GITHUB_REF;
  const prNumber = extractPrNumber(ref);
  if (prNumber === null) {
    // eslint-disable-next-line no-console
    console.log(
      `[post-voice-quality-pr-comment] not a PR run (GITHUB_REF=${ref ?? '<unset>'}), skipping`,
    );
    return 0;
  }

  const token = env.GITHUB_TOKEN;
  if (!token) {
    // eslint-disable-next-line no-console
    console.warn(
      '[post-voice-quality-pr-comment] GITHUB_TOKEN missing, skipping',
    );
    return 0;
  }

  const repository = env.GITHUB_REPOSITORY;
  if (!repository || !repository.includes('/')) {
    // eslint-disable-next-line no-console
    console.warn(
      `[post-voice-quality-pr-comment] GITHUB_REPOSITORY missing or malformed (${repository ?? '<unset>'}), skipping`,
    );
    return 0;
  }
  const [owner, repo] = repository.split('/');

  const reportPath =
    env.REPORT_PATH ??
    path.resolve(process.cwd(), 'packages/api/voice-quality-report.json');
  const report = loadReport(reportPath);
  if (report === null) {
    // eslint-disable-next-line no-console
    console.warn(
      `[post-voice-quality-pr-comment] no report at ${reportPath}; posting fallback`,
    );
  }

  const body = buildCommentBody(report);

  try {
    await postOrUpdateComment({
      fetchImpl: opts.fetchImpl,
      apiBase: opts.apiBase,
      owner,
      repo,
      prNumber,
      token,
      body,
    });
  } catch (err) {
    // Log + exit non-zero so the workflow surfaces the API failure,
    // but don't throw — `if: always()` callers expect a clean exit.
    // eslint-disable-next-line no-console
    console.error(
      `[post-voice-quality-pr-comment] failed: ${(err as Error).message}`,
    );
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
