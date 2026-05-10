/**
 * VQ2-017 — CI workflow integration tests for the Layer 2 *weekly trend*
 * pipeline.
 *
 * Mirrors the VQ2-016 `ci-workflow-layer2.test.ts` pattern. Pins the
 * contracts the weekly-trend rollout depends on:
 *
 *  - `.github/workflows/voice-quality-weekly-trend.yml` exists, parses,
 *    and declares a `trend` job.
 *  - The job runs on a Monday-06:00-UTC cron schedule.
 *  - The workflow grants `issues: write` so the regression auto-issue
 *    step can succeed.
 *  - The trend report artifact is uploaded with retention-days: 90.
 *  - `packages/api/package.json` exposes `voice-quality:layer2:weekly`.
 *
 * Same lightweight string-assertion approach as VQ2-016 — avoids a
 * `js-yaml` dependency for what is a contract smoke test. GitHub
 * Actions is the source of truth for YAML structural validity.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../..');
const weeklyWorkflowPath = path.join(
  repoRoot,
  '.github/workflows/voice-quality-weekly-trend.yml',
);
const apiPackageJsonPath = path.resolve(__dirname, '../../package.json');

function readWorkflow(): string {
  return fs.readFileSync(weeklyWorkflowPath, 'utf-8');
}

describe('VQ2-017 — Layer 2 weekly-trend CI workflow', () => {
  it('VQ2-017 — voice-quality-weekly-trend.yml exists + parses', () => {
    expect(fs.existsSync(weeklyWorkflowPath)).toBe(true);
    const src = readWorkflow();
    expect(src).toMatch(/^name:\s*Voice Quality Layer 2 \(weekly trend\)/m);
    expect(src).toMatch(/workflow_dispatch:/);
    // Job key `trend` at column 2 under `jobs:`.
    expect(src).toMatch(/^\s{2}trend:\s*$/m);
  });

  it('VQ2-017 — workflow uses cron 0 6 * * 1 (Monday 06:00 UTC)', () => {
    const src = readWorkflow();
    expect(src).toMatch(/schedule:/);
    expect(src).toMatch(/cron:\s*['"]0 6 \* \* 1['"]/);
  });

  it('VQ2-017 — workflow has issues:write permission', () => {
    const src = readWorkflow();
    // The auto-issue step needs `issues: write`. Pin it explicitly so a
    // permission downgrade fails this test instead of silently breaking
    // the regression auto-issue.
    expect(src).toMatch(/issues:\s*write/);
  });

  it('VQ2-017 — workflow uploads trend artifact with retention-days: 90', () => {
    const src = readWorkflow();
    expect(src).toMatch(/actions\/upload-artifact@v4/);
    expect(src).toMatch(/voice-quality-trend-report/);
    expect(src).toMatch(/voice-quality-trend-report\.json/);
    expect(src).toMatch(/retention-days:\s*90/);
  });

  it('VQ2-017 — voice-quality:layer2:weekly npm script exists', () => {
    const raw = fs.readFileSync(apiPackageJsonPath, 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts!['voice-quality:layer2:weekly']).toBeDefined();
    expect(pkg.scripts!['voice-quality:layer2:weekly']).toMatch(
      /VOICE_QUALITY_LAYER2_WEEKLY=true/,
    );
  });
});
