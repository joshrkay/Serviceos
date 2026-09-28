/**
 * #1331 — CI contract: both Voice Quality Layer 2 workflows run the suite on
 * the provider production runs.
 *
 * Railway prod/dev: AI_PROVIDER_BASE_URL=https://api.openai.com/v1 +
 * AI_PROVIDER_API_KEY, gpt-4o-mini (default/lightweight/standard), gpt-4o
 * (complex), AI_CLASSIFY_INTENT_DEADLINE_MS=12000. The Anthropic account
 * behind secrets.ANTHROPIC_API_KEY has no credit (the 2026-09-28 scheduled
 * run failed every script with "400 Your credit balance is too low") and
 * production never calls it. Same shape as ci-workflow-path-smoke (#1426) and
 * ci-workflow-voice-eval-live (#1431).
 */
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { selectLayer2Providers } from '../../src/ai/gateway/real-layer-two-factory';
import { loadLayer2Corpus } from '../../src/ai/voice-quality/corpus/loader';
import { projectLayer2SuiteCents } from '../../src/ai/voice-quality/runner-layer2';

const repoRoot = path.resolve(__dirname, '../../../..');
const WORKFLOWS = [
  '.github/workflows/voice-quality-weekly-trend.yml',
  '.github/workflows/voice-quality-pre-deploy.yml',
] as const;

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

/** The job-level env block (between the job's `env:` and its `steps:`). */
function jobEnv(src: string): Record<string, string> {
  const head = src.slice(src.indexOf('\n    env:'), src.indexOf('\n    steps:'));
  const env: Record<string, string> = {};
  for (const m of head.matchAll(/^ {6}([A-Z0-9_]+):\s*'?([^'\n#]*?)'?\s*(?:#.*)?$/gm)) env[m[1]] = m[2];
  return env;
}

/** A cap more than this multiple of its projection was sized for a pricier model. */
const MAX_CAP_OVER_PROJECTION = 3;

describe.each(WORKFLOWS)('%s — Layer 2 provider contract', (workflow) => {
  it('exports the production provider config (OpenAI, gpt-4o-mini / gpt-4o), not Anthropic', () => {
    const env = jobEnv(read(workflow));
    expect(env).toMatchObject({
      AI_PROVIDER_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
      AI_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
      AI_DEFAULT_MODEL: 'gpt-4o-mini',
      AI_LIGHTWEIGHT_MODEL: 'gpt-4o-mini',
      AI_STANDARD_MODEL: 'gpt-4o-mini',
      AI_COMPLEX_MODEL: 'gpt-4o',
      AI_CLASSIFY_INTENT_DEADLINE_MS: '12000',
      // Whisper STT + OpenAI TTS.
      OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
    });
    expect(read(workflow)).not.toMatch(/secrets\.ANTHROPIC_API_KEY/);
  });

  it('the suite selects the production provider with gpt-4o-mini from that env', () => {
    const plan = selectLayer2Providers({
      ...jobEnv(read(workflow)),
      AI_PROVIDER_API_KEY: 'ci-secret',
      OPENAI_API_KEY: 'ci-secret',
    });
    expect(plan.ok && plan.llm).toMatchObject({ kind: 'production', model: 'gpt-4o-mini' });
  });

  it('fails closed before the suite when AI_PROVIDER_API_KEY or OPENAI_API_KEY is absent', () => {
    const src = read(workflow);
    const check = src.indexOf('::error::AI_PROVIDER_API_KEY');
    expect(check).toBeGreaterThan(-1);
    expect(src).toMatch(/if \[ -z "\$AI_PROVIDER_API_KEY" \] \|\| \[ -z "\$OPENAI_API_KEY" \]; then/);
    expect(src.slice(check)).toMatch(/exit 1/);
    expect(check).toBeLessThan(src.indexOf('run: npm run voice-quality:layer2'));
  });

  it('caps the suite at a budget sized for gpt-4o-mini: above the projection, within 3x of it', () => {
    const env = jobEnv(read(workflow));
    const cap = Number(env.VOICE_QUALITY_COST_CAP_CENTS);
    const projected = projectLayer2SuiteCents({ scripts: loadLayer2Corpus(), model: 'gpt-4o-mini' });
    expect(projected).not.toBeNull();
    const msg = `cap ${cap}c vs projected ${projected!.toFixed(1)}c`;
    console.log(`${workflow}: ${msg}`);
    expect(cap, msg).toBeGreaterThanOrEqual(projected!);
    expect(cap, msg).toBeLessThanOrEqual(projected! * MAX_CAP_OVER_PROJECTION);
  });
});
