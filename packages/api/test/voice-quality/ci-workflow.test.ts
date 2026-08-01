/**
 * VQ-024 — CI workflow integration tests.
 *
 * Pins the contracts the Voice Quality v1 CI rollout depends on:
 *
 *  - `.github/workflows/pr-checks.yml` declares a `voice-quality` job
 *    that runs the corpus suite on every PR.
 *  - `.github/workflows/voice-quality-nightly.yml` exists and runs the
 *    enforced memory-mode Layer-1 gate (the decorative pg variant was
 *    removed — QUALITY-2026-07-12 WS1).
 *  - `packages/api/package.json` exposes the `voice-quality` script the
 *    CI jobs invoke via `npm run voice-quality --workspace=packages/api`.
 *  - Both workflow files resolve to Node 20 so the runner stays in lockstep
 *    with the rest of the pipeline. Checked via `expectEffectiveNode20`,
 *    which accepts either an inline `node-version:` or a
 *    `node-version-file: '.nvmrc'` and validates the version that actually
 *    results — the repo standardised on the latter, and an assertion that
 *    matched only the literal spelling failed the migration despite every
 *    workflow still running Node 20.
 *
 * We deliberately use lightweight string assertions (not a full YAML
 * parser) to avoid pulling `js-yaml` into the API package's deps just
 * for a smoke test. The workflow files are short and the tokens we
 * pin are stable contract shapes — `name:`, the Node pin,
 * `voice-quality:` job key, `npm run voice-quality`. A YAML structural
 * regression that broke the file would be caught by GitHub Actions on
 * the next PR; this test catches the higher-level contract drift
 * (e.g., someone renames the job, drops the npm script, downgrades
 * Node).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { expectEffectiveNode20 } from '../helpers/workflow-node-version';

const repoRoot = path.resolve(__dirname, '../../../..');
const prChecksPath = path.join(repoRoot, '.github/workflows/pr-checks.yml');
const nightlyPath = path.join(
  repoRoot,
  '.github/workflows/voice-quality-nightly.yml',
);
const apiPackageJsonPath = path.resolve(__dirname, '../../package.json');

describe('VQ-024 — CI workflow integration', () => {
  it('VQ-024 — pr-checks.yml contains a voice-quality job with the launch gate enforced', () => {
    expect(fs.existsSync(prChecksPath)).toBe(true);
    const src = fs.readFileSync(prChecksPath, 'utf-8');
    // Job key at column 2 under `jobs:` — pin the shape so a stray
    // rename or a step-named voice-quality wouldn't satisfy it.
    expect(src).toMatch(/^\s{2}voice-quality:\s*$/m);
    // The job must invoke the npm script via the workspaces flag so
    // it picks up the right package's vitest config.
    expect(src).toMatch(/npm run voice-quality --workspace=packages\/api/);
    // Report artifact upload — graders/aggregators consume this in
    // VQ-025.
    expect(src).toMatch(/voice-quality-report\.json/);
    // WS1 (QUALITY-2026-07-12) — the launch gate MUST be enforced so the
    // merge step fails the job on any launch-gate blocker. Pin it so a
    // future edit can't silently drop enforcement back to advisory.
    expect(src).toMatch(/VOICE_QUALITY_ENFORCE_LAUNCH_GATE:\s*['"]true['"]/);
  });

  it('WS1 — voice-quality-nightly.yml runs the enforced memory-mode Layer-1 gate (no decorative pg run)', () => {
    expect(fs.existsSync(nightlyPath)).toBe(true);
    const src = fs.readFileSync(nightlyPath, 'utf-8');
    // Top-level workflow name + a recognisable schedule trigger.
    expect(src).toMatch(/^name:\s*Voice Quality \(nightly\)/m);
    expect(src).toMatch(/schedule:/);
    expect(src).toMatch(/cron:\s*['"]0 6 \* \* \*['"]/);
    expect(src).toMatch(/npm run voice-quality --workspace=packages\/api/);
    expect(src).toMatch(/VOICE_QUALITY_CASSETTE_MODE:\s*replay/);
    // The nightly enforces the launch gate — a regression reddens it.
    expect(src).toMatch(/VOICE_QUALITY_ENFORCE_LAUNCH_GATE:\s*['"]true['"]/);
    // The decorative pg run was removed: no pg repo mode, no postgres service,
    // and no continue-on-error masking a failed corpus run.
    expect(src).not.toMatch(/VOICE_QUALITY_REPO:\s*pg/);
    expect(src).not.toMatch(/postgres:16-alpine/);
    expect(src).not.toMatch(/continue-on-error:\s*true\s*#\s*TODO/);
  });

  it('VQ-024 — voice-quality npm script exists in packages/api/package.json', () => {
    const raw = fs.readFileSync(apiPackageJsonPath, 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts!['voice-quality']).toBeDefined();
    expect(pkg.scripts!['voice-quality']).toMatch(
      /vitest run -c vitest\.voice-quality\.config\.ts/,
    );
  });

  it('VQ-024 — both workflow files resolve to Node 20', () => {
    expectEffectiveNode20(fs.readFileSync(prChecksPath, 'utf-8'), 'pr-checks.yml');
    expectEffectiveNode20(
      fs.readFileSync(nightlyPath, 'utf-8'),
      'voice-quality-nightly.yml',
    );
  });
});
