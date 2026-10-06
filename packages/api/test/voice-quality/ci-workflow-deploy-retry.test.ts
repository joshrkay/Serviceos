/**
 * #1631 — CI contract test for `.github/workflows/deploy-retry.yml`.
 *
 * On 2026-10-05 three consecutive Deploy runs on main ended `failure`
 * because individual jobs were `cancelled` by GitHub's hosted-runner
 * pool, not by a real test/deploy failure. This workflow listens for
 * completed `Deploy` runs and retries them automatically — see
 * `.github/scripts/deploy-retry-decision.ts` for the decision rule.
 *
 * Same lightweight string-assertion approach as the other
 * `ci-workflow*.test.ts` files — avoids a `js-yaml` dependency for what
 * is a contract smoke test. GitHub Actions is the source of truth for
 * YAML structural validity.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/deploy-retry.yml');

function readWorkflow(): string {
  return fs.readFileSync(workflowPath, 'utf-8');
}

describe('#1631 — deploy-retry.yml', () => {
  it('exists and declares the retry job', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const src = readWorkflow();
    expect(src).toMatch(/^name:\s*Deploy Retry/m);
    expect(src).toMatch(/^\s{2}retry:\s*$/m);
  });

  it('triggers on workflow_run completed for the Deploy workflow on main', () => {
    const src = readWorkflow();
    expect(src).toMatch(/workflow_run:/);
    expect(src).toMatch(/types:\s*\[completed\]/);
    expect(src).toMatch(/workflows:\s*\["?Deploy"?\]/);
    expect(src).toMatch(/branches:\s*\[main\]/);
  });

  it('grants only actions:write and contents:write', () => {
    const src = readWorkflow();
    expect(src).toMatch(/permissions:\s*\n\s*actions:\s*write/);
    expect(src).toMatch(/contents:\s*write/);
    // No broader scopes snuck in (issues, pull-requests, etc.).
    expect(src).not.toMatch(/issues:\s*write/);
    expect(src).not.toMatch(/pull-requests:\s*write/);
  });

  it('fetches the run jobs via gh api and gates the decision script on them', () => {
    const src = readWorkflow();
    expect(src).toMatch(/gh api/);
    expect(src).toMatch(/actions\/runs\/.*\/jobs/);
    expect(src).toMatch(/deploy-retry-decision\.ts/);
  });

  it('reruns only when the decision step says retry == true, via gh run rerun --failed', () => {
    const src = readWorkflow();
    expect(src).toMatch(/steps\.decide\.outputs\.retry == 'true'/);
    expect(src).toMatch(/gh run rerun/);
    expect(src).toMatch(/--failed/);
  });

  it('posts a commit comment on retry, via the commit comments API', () => {
    const src = readWorkflow();
    expect(src).toMatch(/commits\/.*\/comments/);
    expect(src).toMatch(/head_sha/);
  });

  it('never retries a commit that is no longer the tip of main', () => {
    const src = readWorkflow();
    expect(src).toMatch(/git\/ref\/heads\/main/);
    expect(src).toMatch(/RUN_SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha/);
    expect(src).toMatch(/MAIN_SHA:\s*\$\{\{\s*steps\.tip\.outputs\.sha/);
  });

  it('passes the comment body via env, never interpolated into the shell script', () => {
    const src = readWorkflow();
    expect(src).toMatch(/COMMENT_BODY:\s*\$\{\{\s*steps\.decide\.outputs\.comment/);
    expect(src).not.toMatch(/body="\$\{\{/);
  });

  it('every `uses:` action is SHA-pinned (40 hex chars) with a version comment', () => {
    const src = readWorkflow();
    const usesLines = src.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line).toMatch(/uses:\s*[\w-]+\/[\w.-]+@[0-9a-f]{40}\s*#\s*v[\d.]+/);
    }
  });
});
