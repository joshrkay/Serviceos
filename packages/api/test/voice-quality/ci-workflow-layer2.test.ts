/**
 * VQ2-016 — CI workflow integration tests for the Layer 2 pre-deploy
 * pipeline.
 *
 * Mirrors the VQ-024 `ci-workflow.test.ts` pattern. Pins the contracts
 * the Layer 2 pre-deploy rollout depends on:
 *
 *  - `.github/workflows/voice-quality-pre-deploy.yml` exists, parses,
 *    and declares a `layer2` job.
 *  - The job pins Node 20, has `timeout-minutes: 30`, installs ffmpeg,
 *    runs the `voice-quality:layer2` npm script, and uploads the
 *    `voice-quality-layer2-report` artifact.
 *  - The Layer 2 step is a GATE (no `continue-on-error`).
 *  - A concurrency group is configured so two pushes to release/* don't
 *    race and double-spend the API budget.
 *  - `packages/api/package.json` exposes `voice-quality:layer2` and
 *    `voice-quality:layer2:weekly`.
 *
 * Same lightweight string-assertion approach as VQ-024 — avoids a
 * `js-yaml` dependency for what is a contract smoke test. GitHub
 * Actions is the source of truth for YAML structural validity.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../..');
const preDeployPath = path.join(
  repoRoot,
  '.github/workflows/voice-quality-pre-deploy.yml',
);
const apiPackageJsonPath = path.resolve(__dirname, '../../package.json');

function readWorkflow(): string {
  return fs.readFileSync(preDeployPath, 'utf-8');
}

describe('VQ2-016 — Layer 2 pre-deploy CI workflow', () => {
  it('VQ2-016 — voice-quality-pre-deploy.yml exists and parses', () => {
    expect(fs.existsSync(preDeployPath)).toBe(true);
    const src = readWorkflow();
    // Top-level workflow name + recognisable trigger shape.
    expect(src).toMatch(/^name:\s*Voice Quality Layer 2 \(pre-deploy\)/m);
    // Triggers on push to release/* branches and supports manual dispatch.
    expect(src).toMatch(/release\/\*/);
    expect(src).toMatch(/workflow_dispatch:/);
    // The job key is `layer2` under `jobs:`.
    expect(src).toMatch(/^\s{2}layer2:\s*$/m);
  });

  it('VQ2-016 — workflow uses Node 20', () => {
    const src = readWorkflow();
    // `node-version: '20'` (quoted) or `node-version: 20` (inline) —
    // either is acceptable; pin major version 20.
    expect(src).toMatch(/node-version:\s*['"]?20['"]?/);
  });

  it('VQ2-016 — workflow has timeout-minutes: 30', () => {
    const src = readWorkflow();
    expect(src).toMatch(/timeout-minutes:\s*30/);
  });

  it('VQ2-016 — workflow installs ffmpeg', () => {
    const src = readWorkflow();
    // Layer 2 needs ffmpeg for AudioModeDriver / WAV decoding. Pin the
    // apt-get install token so a refactor that drops it fails this test.
    expect(src).toMatch(/apt-get install[^\n]*ffmpeg/);
  });

  it('VQ2-016 — workflow does NOT use continue-on-error on the Layer 2 step (it is a gate)', () => {
    const src = readWorkflow();
    // The Layer 2 corpus run step (id: layer2 / `npm run voice-quality:layer2`)
    // must NOT be marked `continue-on-error`. A post-comment step MAY be
    // (cosmetic only), so we scope the check to the lines around the
    // `voice-quality:layer2` npm invocation.
    const lines = src.split('\n');
    const idx = lines.findIndex((l) => /npm run voice-quality:layer2/.test(l));
    expect(idx).toBeGreaterThanOrEqual(0);
    // Walk a small window before/after the run line until we hit the
    // next step boundary (a line starting with `      - ` after dedent
    // or `      -  name:`). The contract: no `continue-on-error: true`
    // attached to this specific step.
    const windowStart = Math.max(0, idx - 4);
    const windowEnd = Math.min(lines.length, idx + 4);
    const windowText = lines.slice(windowStart, windowEnd).join('\n');
    expect(windowText).not.toMatch(/continue-on-error:\s*true/);
  });

  it('VQ2-016 — workflow uploads the layer2-report artifact', () => {
    const src = readWorkflow();
    expect(src).toMatch(/actions\/upload-artifact@v4/);
    expect(src).toMatch(/name:\s*voice-quality-layer2-report/);
    expect(src).toMatch(/voice-quality-layer2-report\.json/);
  });

  it('VQ2-016 — voice-quality:layer2 npm script exists', () => {
    const raw = fs.readFileSync(apiPackageJsonPath, 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts!['voice-quality:layer2']).toBeDefined();
    // The script wires through the dedicated Layer 2 vitest config so
    // the runner doesn't pick up the 4-fork Layer 1 pool.
    expect(pkg.scripts!['voice-quality:layer2']).toMatch(
      /vitest run -c vitest\.voice-quality-layer2\.config\.ts/,
    );
    // VQ2-017 hooks the weekly variant; pin it now to avoid drift.
    expect(pkg.scripts!['voice-quality:layer2:weekly']).toBeDefined();
    expect(pkg.scripts!['voice-quality:layer2:weekly']).toMatch(
      /VOICE_QUALITY_LAYER2_WEEKLY=true/,
    );
  });

  it('VQ2-016 — concurrency group prevents parallel runs', () => {
    const src = readWorkflow();
    // The concurrency block is what protects the API spend cap from
    // double-runs on rapid release/* pushes.
    expect(src).toMatch(/concurrency:/);
    expect(src).toMatch(
      /group:\s*voice-quality-layer2-\$\{\{\s*github\.ref\s*\}\}/,
    );
    // We deliberately do NOT cancel an in-flight run — cost is already
    // sunk by the time a second push arrives.
    expect(src).toMatch(/cancel-in-progress:\s*false/);
  });
});
