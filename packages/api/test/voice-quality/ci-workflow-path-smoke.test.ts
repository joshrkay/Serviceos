/**
 * CI contract tests for agent graph coverage + real-LLM path smoke.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/agent-path-smoke.yml');
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

  it('skips cleanly when ANTHROPIC_API_KEY is absent (fork safety)', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/::warning::ANTHROPIC_API_KEY is not set/);
    expect(src).toMatch(/has_key=false/);
    expect(src).toMatch(/steps\.check\.outputs\.has_key == 'true'/);
  });

  it('uploads the path-smoke report artifact', () => {
    const src = fs.readFileSync(workflowPath, 'utf-8');
    expect(src).toMatch(/actions\/upload-artifact/);
    expect(src).toMatch(/agent-path-smoke-report/);
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
