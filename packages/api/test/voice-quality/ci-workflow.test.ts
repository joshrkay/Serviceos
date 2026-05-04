/**
 * VQ-024 — CI workflow integration tests.
 *
 * Pins the contracts the Voice Quality v1 CI rollout depends on:
 *
 *  - `.github/workflows/pr-checks.yml` declares a `voice-quality` job
 *    that runs the corpus suite on every PR.
 *  - `.github/workflows/voice-quality-nightly.yml` exists and is a
 *    valid YAML document for the nightly Pg variant.
 *  - `packages/api/package.json` exposes the `voice-quality` script the
 *    CI jobs invoke via `npm run voice-quality --workspace=packages/api`.
 *  - Both workflow files specify Node 20 so the runner stays in lockstep
 *    with the rest of the pipeline.
 *
 * We deliberately use lightweight string assertions (not a full YAML
 * parser) to avoid pulling `js-yaml` into the API package's deps just
 * for a smoke test. The workflow files are short and the tokens we
 * pin are stable contract shapes — `name:`, `node-version:`,
 * `voice-quality:` job key, `npm run voice-quality`. A YAML structural
 * regression that broke the file would be caught by GitHub Actions on
 * the next PR; this test catches the higher-level contract drift
 * (e.g., someone renames the job, drops the npm script, downgrades
 * Node).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../..');
const prChecksPath = path.join(repoRoot, '.github/workflows/pr-checks.yml');
const nightlyPath = path.join(
  repoRoot,
  '.github/workflows/voice-quality-nightly.yml',
);
const apiPackageJsonPath = path.resolve(__dirname, '../../package.json');

describe('VQ-024 — CI workflow integration', () => {
  it('VQ-024 — pr-checks.yml contains a voice-quality job', () => {
    expect(fs.existsSync(prChecksPath)).toBe(true);
    const src = fs.readFileSync(prChecksPath, 'utf-8');
    // Job key at column 2 under `jobs:` — pin the shape so a stray
    // rename or a step-named voice-quality wouldn't satisfy it.
    expect(src).toMatch(/^\s{2}voice-quality:\s*$/m);
    // The job must invoke the npm script via the workspaces flag so
    // it picks up the right package's vitest config.
    expect(src).toMatch(/npm run voice-quality --workspace=packages\/api/);
    // The replay-mode env vars must be set so the runner doesn't try
    // to call out to a real LLM provider in CI.
    expect(src).toMatch(/VOICE_QUALITY_REPO:\s*memory/);
    expect(src).toMatch(/VOICE_QUALITY_CASSETTE_MODE:\s*replay/);
    // Report artifact upload — graders/aggregators consume this in
    // VQ-025.
    expect(src).toMatch(/voice-quality-report\.json/);
  });

  it('VQ-024 — voice-quality-nightly.yml exists and parses as YAML', () => {
    expect(fs.existsSync(nightlyPath)).toBe(true);
    const src = fs.readFileSync(nightlyPath, 'utf-8');
    // Top-level workflow name + a recognisable schedule trigger.
    expect(src).toMatch(/^name:\s*Voice Quality \(nightly Pg\)/m);
    expect(src).toMatch(/schedule:/);
    expect(src).toMatch(/cron:\s*['"]0 6 \* \* \*['"]/);
    // Pg variant: the runner is configured for the pg repo bundle.
    expect(src).toMatch(/VOICE_QUALITY_REPO:\s*pg/);
    expect(src).toMatch(/VOICE_QUALITY_CASSETTE_MODE:\s*replay/);
    // A postgres service must be declared so the testcontainer-style
    // workflow has a DB to point at.
    expect(src).toMatch(/postgres:16-alpine/);
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

  it('VQ-024 — both workflow files specify Node 20', () => {
    const prSrc = fs.readFileSync(prChecksPath, 'utf-8');
    const nightlySrc = fs.readFileSync(nightlyPath, 'utf-8');
    // `node-version: '20'` (pr-checks legacy form) or
    // `node-version: 20` (inline form used in the new job) — either
    // is acceptable; pin major version 20 only.
    expect(prSrc).toMatch(/node-version:\s*['"]?20['"]?/);
    expect(nightlySrc).toMatch(/node-version:\s*['"]?20['"]?/);
  });
});
