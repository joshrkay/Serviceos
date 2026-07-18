/**
 * CI workflow contract test for the LIVE voice-eval pipeline
 * (.github/workflows/voice-eval-live.yml).
 *
 * Same lightweight string-assertion approach as ci-workflow-layer2*.test.ts —
 * GitHub Actions is the source of truth for YAML structural validity; this pins
 * the contract the rollout depends on (triggers, gating, secrets, cost caps,
 * fork safety, artifact upload) so an accidental edit is caught in PR CI.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/voice-eval-live.yml');

function read(): string {
  return fs.readFileSync(workflowPath, 'utf-8');
}

describe('voice-eval-live.yml — scheduled live eval workflow', () => {
  it('exists and declares the live-eval job', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const src = read();
    expect(src).toMatch(/^name:\s*Voice Eval Live/m);
    expect(src).toMatch(/live-eval:/);
  });

  it('triggers on a weekly cron + manual dispatch (NOT on pull_request)', () => {
    const src = read();
    expect(src).toMatch(/workflow_dispatch:/);
    expect(src).toMatch(/cron:\s*'0 7 \* \* 1'/);
    // No pull_request TRIGGER (the word may appear in explanatory comments).
    expect(src).not.toMatch(/^\s*pull_request:/m);
  });

  it('runs both evals with --live --gate and bounded sampling', () => {
    const src = read();
    expect(src).toMatch(/run-intent-eval\.ts --live --gate --max-utterances \d+/);
    expect(src).toMatch(/run-slot-eval\.ts --live --gate --max-utterances \d+/);
  });

  it('uses the Layer-2 secret names and a per-script cost cap', () => {
    const src = read();
    expect(src).toMatch(/ANTHROPIC_API_KEY:\s*\$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
    expect(src).toMatch(/OPENAI_API_KEY:\s*\$\{\{ secrets\.OPENAI_API_KEY \}\}/);
    expect(src).toMatch(/VOICE_EVAL_COST_CAP_CENTS:/);
  });

  it('skips cleanly with a loud warning when the key is absent (fork safety)', () => {
    const src = read();
    expect(src).toMatch(/::warning::ANTHROPIC_API_KEY is not set/);
    expect(src).toMatch(/has_key=false/);
    expect(src).toMatch(/steps\.check\.outputs\.has_key == 'true'/);
  });

  it('uploads the eval report as an artifact even on failure', () => {
    const src = read();
    expect(src).toMatch(/actions\/upload-artifact/);
    expect(src).toMatch(/voice-eval-live-report/);
    expect(src).toMatch(/if:\s*always\(\)/);
  });

  it('needs no Postgres/Docker/ffmpeg STEPS (classifier + gateway need no DB)', () => {
    const src = read();
    // Assert on actual step/service patterns, not comment prose.
    expect(src).not.toMatch(/^\s*services:/m);
    expect(src).not.toMatch(/docker pull|pgvector\/pgvector/);
    expect(src).not.toMatch(/apt-get install[^\n]*ffmpeg/);
  });
});
