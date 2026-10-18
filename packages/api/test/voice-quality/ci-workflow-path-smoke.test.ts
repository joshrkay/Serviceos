/**
 * CI contract tests for agent graph coverage + real-LLM path smoke.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/agent-path-smoke.yml');
const shimPath = path.join(repoRoot, '.github/workflows/agent-path-smoke-skip.yml');
const apiPackageJsonPath = path.resolve(__dirname, '../../package.json');
const prChecksPath = path.join(repoRoot, '.github/workflows/pr-checks.yml');

describe('agent-path-smoke.yml — real-LLM path smoke workflow', () => {
  it('exists and declares the path-smoke job', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/^name:\s*Agent Path Smoke/m);
    expect(src).toMatch(/path-smoke:/);
  });

  it('supports workflow_dispatch and pull_request (credential-gated)', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/workflow_dispatch:/);
    expect(src).toMatch(/pull_request:/);
  });

  it('runs agent-path-smoke with --gate and a cost cap', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    // Invoked via npm script: `npm run agent:path-smoke -- … --gate`
    expect(src).toMatch(/agent:path-smoke/);
    expect(src).toMatch(/--gate/);
    expect(src).toMatch(/AGENT_PATH_SMOKE_COST_CAP_CENTS:/);
  });

  it('exercises the production provider config (Railway prod/dev: OpenAI, gpt-4o-mini / gpt-4o)', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/AI_PROVIDER_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
    expect(src).toMatch(/AI_PROVIDER_BASE_URL:\s*'?https:\/\/api\.openai\.com\/v1'?/);
    expect(src).toMatch(/AI_DEFAULT_MODEL:\s*'?gpt-4o-mini'?/);
    expect(src).toMatch(/AI_LIGHTWEIGHT_MODEL:\s*'?gpt-4o-mini'?/);
    expect(src).toMatch(/AI_STANDARD_MODEL:\s*'?gpt-4o-mini'?/);
    expect(src).toMatch(/AI_COMPLEX_MODEL:\s*'?gpt-4o'?\s*$/m);
    // Anthropic is not the provider production uses — it must not be wired in
    // CI, or the script's fallback could silently test the wrong provider.
    expect(src).not.toMatch(/secrets\.ANTHROPIC_API_KEY/);
  });

  it('fails closed when AI_PROVIDER_API_KEY is absent', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/::error::AI_PROVIDER_API_KEY is not set/);
    expect(src).toMatch(/exit 1/);
    expect(src).not.toMatch(/has_key=false/);
    expect(src).not.toMatch(/steps\.check\.outputs\.has_key == 'true'/);
  });

  it('uploads the path-smoke report artifact', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/actions\/upload-artifact/);
    expect(src).toMatch(/agent-path-smoke-report/);
  });
});

/**
 * The quoted entries of the YAML list under `key:` (e.g. `paths:` or
 * `paths-ignore:`), read until the list dedents. Both workflows are written
 * with one `- '...'` entry per line, so no YAML parser is needed.
 */
function yamlList(src: string, key: string): string[] {
  const m = new RegExp(String.raw`^( *)${key}:\n((?:\1 +- '[^']*'\n)+)`, 'm').exec(src);
  expect(m, `${key}: list not found`).not.toBeNull();
  return [...m![2].matchAll(/- '([^']*)'/g)].map((x) => x[1]);
}

// OBS-3 — the real-model smoke is the only PR check that calls the
// production model, and it is path-filtered. Branch protection can only
// require a check that reports on EVERY PR, so a sibling workflow with the
// same name and job id passes instantly on the PRs the filter skips
// (GitHub's documented pattern for a required, path-filtered check).
describe('agent-path-smoke-skip.yml — skip-pass shim for the required check', () => {
  it('reports the same check context (workflow name + job id) as the real workflow', () => {
    expect(fs.existsSync(shimPath)).toBe(true);
    const real = fs.readFileSync(workflowPath, 'utf-8');
    const shim = fs.readFileSync(shimPath, 'utf-8');
    const name = /^name:\s*(.+)$/m.exec(real)![1];
    expect(/^name:\s*(.+)$/m.exec(shim)![1]).toBe(name);
    expect(shim).toMatch(/^  path-smoke:$/m);
    // The job id is the check context; a `name:` on the job would rename it.
    expect(shim).not.toMatch(/^    name:/m);
    // The real job must not carry a display name either, or the two diverge.
    expect(real).not.toMatch(/^    name:/m);
  });

  it('ignores exactly the paths the real workflow filters on, so the two can never both skip', () => {
    const real = fs.readFileSync(workflowPath, 'utf-8');
    const shim = fs.readFileSync(shimPath, 'utf-8');
    expect(shim).toMatch(/^on:\n  pull_request:\n    paths-ignore:/m);
    expect(yamlList(shim, 'paths-ignore')).toEqual(yamlList(real, 'paths'));
  });

  it('does nothing but pass: no model call, no secret, no install', () => {
    const shim = fs.readFileSync(shimPath, 'utf-8');
    expect(shim).not.toMatch(/secrets\./);
    expect(shim).not.toMatch(/npm ci|agent:path-smoke|--live/);
    expect(shim).toMatch(/permissions:\n  contents: read/);
  });
});

describe('npm scripts + PR graph coverage', () => {
  it('packages/api exposes agent:graph-coverage and agent:path-smoke scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(apiPackageJsonPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['agent:graph-coverage']).toMatch(/agent-graph-coverage\.ts/);
    expect(pkg.scripts['agent:path-smoke']).toMatch(/agent-path-smoke\.ts/);
  });

  it('pr-checks.yml runs offline graph coverage on every PR', () => {
    expect(fs.existsSync(prChecksPath)).toBe(true);
    const src = fs.readFileSync(prChecksPath, 'utf-8');
    expect(src).toMatch(/agent:graph-coverage/);
    expect(src).toMatch(/--gate/);
  });
});
