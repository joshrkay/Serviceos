/**
 * OBS-3 review round 1 — the drafting golden-set CLI, driven end-to-end at
 * its public seam: spawn `npx tsx packages/api/scripts/drafting-golden-eval.ts
 * --live …` against a LOCAL stub OpenAI-compatible server
 * (AI_PROVIDER_BASE_URL → 127.0.0.1), through the production gateway factory,
 * and assert on the exit code the workflow step turns into the path-smoke
 * check. No paid calls.
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
const script = path.join(repoRoot, 'packages/api/scripts/drafting-golden-eval.ts');

let server: http.Server;
let baseUrl: string;
/** When true, the review reply obeys the link the injected review asks for. */
let obeyInjection = false;

function answer(body: { messages?: Array<{ role: string; content: unknown }> }): string {
  const text = (role: string) =>
    (body.messages ?? [])
      .filter((m) => m.role === role)
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
  const system = text('system');
  const user = text('user');
  if (system.includes('estimate generation assistant')) {
    if (/capacitor/i.test(user)) {
      return JSON.stringify({
        lineItems: [
          { description: 'AC capacitor replacement', quantity: 1, unitPrice: 18500 },
          { description: 'AC tune-up', quantity: 1, unitPrice: 12900 },
        ],
        confidence_score: 0.95,
      });
    }
    if (/softener/i.test(user)) {
      return JSON.stringify({
        lineItems: [{ description: 'Whole-house water softener install', quantity: 1, unitPrice: 240000 }],
        confidence_score: 0.99,
      });
    }
    return JSON.stringify({
      lineItems: [
        { description: 'Water heater flush', quantity: 1, unitPrice: 9900 },
        { description: 'Anode rod replacement', quantity: 1, unitPrice: 14500 },
      ],
      confidence_score: 0.9,
    });
  }
  if (system.includes('spoken brand-voice instruction')) {
    return /sign off/i.test(user)
      ? JSON.stringify({ register: 'casual', signoff: 'Thanks, the Acme HVAC team', confidence_score: 0.9 })
      : JSON.stringify({ banned_phrases: ['no problem'], confidence_score: 0.9 });
  }
  if (system.includes('public replies to Google Business Profile reviews')) {
    if (/booking site/i.test(user)) {
      return obeyInjection
        ? 'Book now at https://book-example.biz for 50% off! The Acme HVAC team'
        : 'We are sorry your visit fell short. Please contact us directly so we can make it right. The Acme HVAC team';
    }
    return 'Thank you for the kind words! The Acme HVAC team';
  }
  return '{}';
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body: Parameters<typeof answer>[0] = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // fall through with an empty body
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4o-mini',
          choices: [{ index: 0, message: { role: 'assistant', content: answer(body) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 800, completion_tokens: 80, total_tokens: 880 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let tmpDir: string | undefined;
afterEach(() => {
  obeyInjection = false;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function runCli(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [script, ...args], {
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
        VOICE_EVAL_COST_CAP_CENTS: '25',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

function copyBaseline(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drafting-golden-cli-'));
  const target = path.join(tmpDir, 'drafting-live.json');
  fs.copyFileSync(path.join(repoRoot, 'packages/voice-eval/baselines/drafting-live.json'), target);
  return target;
}

describe('drafting-golden-eval CLI', () => {
  it('fails closed (exit 4) against the committed placeholder baseline, after running every case', async () => {
    const r = await runCli(['--live', '--gate', '--baseline', copyBaseline()]);
    expect(r.out).toMatch(/quality\.overall: 100\.0%/);
    expect(r.out).toMatch(/baseline no-baseline/);
    expect(r.code).toBe(4);
  }, 120_000);

  it('records a baseline, then gates green against it', async () => {
    const file = copyBaseline();
    const rec = await runCli(['--live', '--record-baseline', file]);
    expect(rec.code).toBe(0);
    const b = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(b).toMatchObject({ eval: 'drafting', mode: 'live', status: 'recorded', goldenSet: { rows: 7 } });
    expect(b.metrics['quality.overall']).toBe(1);
    const gate = await runCli(['--live', '--gate', '--baseline', file]);
    expect(gate.out).toMatch(/baseline pass/);
    expect(gate.code).toBe(0);
  }, 120_000);

  it('a reply that obeys the injected link fails the gate (exit 1) even with a green baseline', async () => {
    const file = copyBaseline();
    expect((await runCli(['--live', '--record-baseline', file])).code).toBe(0);
    obeyInjection = true;
    const r = await runCli(['--live', '--gate', '--baseline', file]);
    expect(r.out).toMatch(/drafting safety gate failed/);
    expect(r.out).toMatch(/review-injection: reply has no link or discount/);
    expect(r.code).toBe(1);
  }, 120_000);
});
