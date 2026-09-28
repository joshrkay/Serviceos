/**
 * voice-eval LIVE runner CLIs, driven end-to-end at their public seam: spawn
 * `npx tsx packages/voice-eval/run-{intent,slot}-eval.ts --live …` against a
 * LOCAL stub OpenAI-compatible server (AI_PROVIDER_BASE_URL → 127.0.0.1), with
 * stdout piped exactly as the workflow's `| tee` does, and assert on the exit
 * code, the printed report and the written baseline file. No paid calls.
 *
 * Regression for the owner-approved baseline run (voice-eval-live.yml,
 * record_baseline=true) that went green while recording NOTHING: both runners
 * printed their header and then the process simply ended with exit 0. The
 * production gateway's retry backoff sleeps on an unref'd timer; when the
 * provider rate-limited a call, that timer was the only thing left in the
 * event loop, so Node drained the loop and exited 0 with `main()` still
 * pending — no report, no baseline, and a green step.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../..');
const tsxBin = path.join(repoRoot, 'node_modules/.bin/tsx');

/** How the stub answers: 429 for the first `rateLimitFirst` calls (or all). */
interface StubBehaviour {
  rateLimitFirst: number | 'all';
}

let server: http.Server;
let baseUrl: string;
let behaviour: StubBehaviour = { rateLimitFirst: 0 };
let calls = 0;

function classificationBody(n: number): string {
  const content = JSON.stringify({
    intentType: 'create_customer',
    confidence: 0.9,
    extractedEntities: { customerName: 'Pat Example' },
  });
  return JSON.stringify({
    id: `chatcmpl-stub-${n}`,
    object: 'chat.completion',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      res.setHeader('content-type', 'application/json');
      const limited = behaviour.rateLimitFirst === 'all' || calls <= behaviour.rateLimitFirst;
      if (limited) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }));
        return;
      }
      res.end(classificationBody(calls));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let tmpDir: string;
afterEach(() => {
  behaviour = { rateLimitFirst: 0 };
  calls = 0;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a runner CLI with stdout/stderr piped (as under `| tee` in CI). */
function runCli(script: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [path.join(repoRoot, 'packages/voice-eval', script), ...args], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AI_PROVIDER_API_KEY: 'sk-stub-not-a-real-key',
        AI_PROVIDER_BASE_URL: baseUrl,
        AI_DEFAULT_MODEL: 'gpt-4o-mini',
        AI_LIGHTWEIGHT_MODEL: 'gpt-4o-mini',
        AI_STANDARD_MODEL: 'gpt-4o-mini',
        AI_COMPLEX_MODEL: 'gpt-4o',
        AI_CLASSIFY_INTENT_DEADLINE_MS: '4000',
        VOICE_EVAL_COST_CAP_CENTS: '150',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function freshBaselinePath(name: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-eval-cli-'));
  const target = path.join(tmpDir, name);
  fs.copyFileSync(path.join(repoRoot, 'packages/voice-eval/baselines', name), target);
  return target;
}

function readBaseline(file: string): { status: string; recordedAt: string | null; goldenSet: { rows: number } | null } {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('run-intent-eval.ts --live (CLI seam, stub provider)', () => {
  it('rides out a transient provider rate limit and still prints the report and records the baseline', async () => {
    behaviour = { rateLimitFirst: 1 };
    const baseline = freshBaselinePath('intent-live.json');

    const r = await runCli('run-intent-eval.ts', ['--live', '--max-utterances', '3', '--record-baseline', baseline]);

    expect(r.stdout).toMatch(/evaluated rows:\s+3/);
    expect(r.stdout).toMatch(/accuracy:\s+\d/);
    expect(r.stdout).toMatch(/recorded intent\/live baseline/);
    expect(r.code).toBe(0);
    const written = readBaseline(baseline);
    expect(written.status).toBe('recorded');
    expect(written.goldenSet?.rows).toBe(3);
  }, 60_000);

  it('exits non-zero — never a silent green — when the provider keeps failing, and records nothing', async () => {
    behaviour = { rateLimitFirst: 'all' };
    const baseline = freshBaselinePath('intent-live.json');

    const r = await runCli('run-intent-eval.ts', ['--live', '--max-utterances', '3', '--record-baseline', baseline]);

    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.stderr).toMatch(/rate limit/i);
    expect(readBaseline(baseline).status).toBe('placeholder');
  }, 60_000);
});

describe('run-slot-eval.ts --live (CLI seam, stub provider)', () => {
  it('rides out a transient provider rate limit and still prints the report and records the baseline', async () => {
    behaviour = { rateLimitFirst: 1 };
    const baseline = freshBaselinePath('slot-live.json');

    const r = await runCli('run-slot-eval.ts', ['--live', '--max-utterances', '3', '--record-baseline', baseline]);

    expect(r.stdout).toMatch(/evaluated:\s+3/);
    expect(r.stdout).toMatch(/micro F1:\s+\d/);
    expect(r.stdout).toMatch(/recorded slot\/live baseline/);
    expect(r.code).toBe(0);
    const written = readBaseline(baseline);
    expect(written.status).toBe('recorded');
    expect(written.goldenSet?.rows).toBe(3);
  }, 60_000);
});
