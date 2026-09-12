/**
 * P2-027 Gap 3 — CI guard demonstrably fails on planted direct provider call
 *
 * Tests that check-ai-gateway-guard.sh:
 *   - exits 0 when no direct calls exist
 *   - exits non-zero when a direct `new OpenAI(` or
 *     `client.chat.completions.create` call is planted
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const GUARD_SCRIPT = path.resolve(
  __dirname,
  '../../scripts/check-ai-gateway-guard.sh'
);

const API_SRC = path.resolve(__dirname, '../../src');

describe('P2-027 Gap 3 — AI gateway guard', () => {
  it('script exists and is executable', () => {
    expect(fs.existsSync(GUARD_SCRIPT)).toBe(true);
    const stat = fs.statSync(GUARD_SCRIPT);
    // owner-execute bit
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });

  it('exits 0 on clean codebase (no direct OpenAI calls outside gateway/providers)', () => {
    expect(() => {
      execSync(`bash "${GUARD_SCRIPT}"`, {
        cwd: path.resolve(__dirname, '../..'),
        stdio: 'pipe',
      });
    }).not.toThrow();
  });

  it('exits non-zero when a planted direct `new OpenAI(` call is detected', () => {
    const tmpFile = path.join(os.tmpdir(), `planted-openai-${Date.now()}.ts`);
    try {
      // Plant a direct OpenAI call in a temp file that looks like it's in src/
      fs.writeFileSync(tmpFile, `import OpenAI from 'openai';\nconst client = new OpenAI({ apiKey: 'x' });\n`);

      // Run the guard with the planted file path injected as an extra search target
      // by temporarily symlinking it into a non-gateway src location.
      // Simpler: just run the guard against a temp directory with the planted file.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-guard-test-'));
      const plantedPath = path.join(tmpDir, 'planted.ts');
      fs.writeFileSync(plantedPath, `import OpenAI from 'openai';\nconst client = new OpenAI({ apiKey: 'x' });\n`);

      let threw = false;
      try {
        execSync(`bash "${GUARD_SCRIPT}" "${tmpDir}"`, {
          cwd: path.resolve(__dirname, '../..'),
          stdio: 'pipe',
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('exits non-zero when a planted `client.chat.completions.create` call is detected', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-guard-test-'));
    const plantedPath = path.join(tmpDir, 'planted.ts');
    fs.writeFileSync(
      plantedPath,
      `const result = await client.chat.completions.create({ model: 'gpt-4', messages: [] });\n`
    );

    let threw = false;
    try {
      execSync(`bash "${GUARD_SCRIPT}" "${tmpDir}"`, {
        cwd: path.resolve(__dirname, '../..'),
        stdio: 'pipe',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// §5 I15 SCOPE CAVEAT (#1021) — the guard above is OpenAI-specific
//
// The PRD's I15 row carries the caveat verbatim: *"Scope caveat:
// OpenAI-specific — an `@anthropic-ai/sdk` import would pass it"*. The shell
// guard's pattern list is `new OpenAI(`, `client.chat.completions.create`,
// and `from 'openai'`. Every one of those is a string about ONE vendor, so
// I15's law — "No module outside it may import a provider SDK" (D-005) —
// held only for the vendor the repo happened to start with.
//
// This closes the caveat in the test lane rather than by editing the shell
// script, so the guard stays a vitest structural test (#1021's brief) and the
// vendor list lives next to the negative controls that prove it works.
//
// **The rule in one sentence:** no module outside `src/ai/gateway` and
// `src/ai/providers` may import ANY LLM provider SDK, construct a provider
// client, or reach a provider HTTP endpoint directly.
// ───────────────────────────────────────────────────────────────────────────

import { describe as describeSdk, it as itSdk, expect as expectSdk } from 'vitest';
import {
  listSourceFiles,
  plantTree,
  removeTree,
  type SourceFile,
} from '../support/structural-scan';

const API_SRC_DIR = path.resolve(__dirname, '../../src');

/**
 * The directories that ARE the gateway — the only place a provider SDK may be
 * imported (D-005). Mirrors the shell guard's GATEWAY_DIR / PROVIDERS_DIR.
 */
const GATEWAY_TREES = ['src/ai/gateway/', 'src/ai/providers/'] as const;

/**
 * Every LLM provider SDK package this repo could plausibly reach for. Exact
 * module specifiers (or their `/` subpaths), so a relative `from '../ai/...'`
 * is never mistaken for the Vercel `ai` package.
 *
 * Listed by vendor rather than pattern-matched, because "is this an LLM SDK"
 * is a fact about the package, not about its name — and because a reviewer
 * adding a vendor should have to add it here, in front of the negative
 * control that proves the guard catches it.
 */
const PROVIDER_SDK_PACKAGES = [
  'openai',
  '@anthropic-ai/sdk',
  '@anthropic-ai/bedrock-sdk',
  '@anthropic-ai/vertex-sdk',
  '@google/generative-ai',
  '@google/genai',
  '@google-cloud/vertexai',
  '@aws-sdk/client-bedrock-runtime',
  'cohere-ai',
  '@mistralai/mistralai',
  'groq-sdk',
  'replicate',
  'together-ai',
  'ollama',
  'ai',
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  'langchain',
  '@langchain/core',
  '@langchain/openai',
  '@langchain/anthropic',
] as const;

/** Direct client construction / call shapes, vendor by vendor. */
const PROVIDER_CALL_SHAPES: ReadonlyArray<{ vendor: string; pattern: RegExp }> = [
  { vendor: 'openai', pattern: /\bnew\s+OpenAI\s*\(/ },
  { vendor: 'openai', pattern: /\.chat\.completions\.create\s*\(/ },
  { vendor: 'anthropic', pattern: /\bnew\s+Anthropic(?:Bedrock|Vertex)?\s*\(/ },
  { vendor: 'anthropic', pattern: /\.messages\.(?:create|stream)\s*\(/ },
  { vendor: 'google', pattern: /\bnew\s+GoogleGenerativeAI\s*\(|\.generateContent\s*\(/ },
  { vendor: 'cohere', pattern: /\bnew\s+CohereClient\s*\(/ },
  { vendor: 'mistral', pattern: /\bnew\s+Mistral(?:Client)?\s*\(/ },
  { vendor: 'groq', pattern: /\bnew\s+Groq\s*\(/ },
];

/** Provider HTTP endpoints — an SDK-free `fetch` bypasses every import guard. */
const PROVIDER_ENDPOINTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'api.groq.com',
  'bedrock-runtime.',
] as const;

/**
 * Speech paths on the same vendor hosts, which I15 does NOT govern.
 *
 * D-005 and I15 are about **LLM calls** — "cost, retries and the audit trail"
 * of a completion. `POST api.openai.com/v1/audio/speech` (TTS) and
 * `/v1/audio/transcriptions` (STT) are neither completions nor routed through
 * `LLMGateway.complete`; they have their own provider abstractions
 * (`ai/tts/tts-provider.ts`, `voice/transcription-providers.ts`). Excluding
 * them by PATH rather than by file keeps the exclusion narrow: a chat
 * completion on the very same host still fails, as the negative control below
 * proves.
 *
 * Flagged in the lane report as a scope question for Fable: if the product
 * wants speech spend on the same cost/audit rail as completions, that is a
 * gateway change, not a guard change.
 */
const NON_LLM_VENDOR_PATHS = ['/v1/audio/', '/v1/speech', '/audio/transcriptions'] as const;

interface ProviderBypass {
  readonly at: string;
  readonly kind: 'sdk-import' | 'client-call' | 'http-endpoint';
  readonly detail: string;
  readonly snippet: string;
}

function importSpecifiers(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/(?:from|require\s*\(|import\s*\()\s*['"]([^'"]+)['"]/g)) {
    out.push(m[1]);
  }
  return out;
}

function isProviderPackage(spec: string): boolean {
  return PROVIDER_SDK_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`));
}

function inGatewayTree(rel: string): boolean {
  return GATEWAY_TREES.some((t) => rel.startsWith(t));
}

/**
 * Every direct provider reach outside the gateway trees. Pure in its roots,
 * so the negative controls can point it at a planted tree — the same property
 * that makes the shell guard above provable.
 */
export function providerBypassesOutsideGateway(roots: readonly string[]): ProviderBypass[] {
  const found: ProviderBypass[] = [];
  for (const file of listSourceFiles(roots) as SourceFile[]) {
    if (inGatewayTree(file.rel)) continue;
    const code = file.code.split('\n');
    const raw = file.text.split('\n');
    for (let i = 0; i < code.length; i += 1) {
      const at = `${file.rel}:${i + 1}`;
      const snippet = (raw[i] ?? '').trim();
      for (const spec of importSpecifiers(code[i])) {
        if (isProviderPackage(spec)) {
          found.push({ at, kind: 'sdk-import', detail: spec, snippet });
        }
      }
      for (const shape of PROVIDER_CALL_SHAPES) {
        if (shape.pattern.test(code[i])) {
          found.push({ at, kind: 'client-call', detail: shape.vendor, snippet });
        }
      }
      for (const endpoint of PROVIDER_ENDPOINTS) {
        if (!code[i].includes(endpoint)) continue;
        if (NON_LLM_VENDOR_PATHS.some((p) => code[i].includes(p))) continue;
        found.push({ at, kind: 'http-endpoint', detail: endpoint, snippet });
      }
    }
  }
  return found;
}

describeSdk('§5 I15 scope caveat (STRUCTURAL) — NO provider SDK, not just OpenAI', () => {
  itSdk('the clean tree reaches no provider directly outside src/ai/gateway and src/ai/providers', () => {
    expectSdk(
      providerBypassesOutsideGateway([API_SRC_DIR]).map(
        (b) => `${b.at}  [${b.kind}: ${b.detail}]  ${b.snippet}`,
      ),
      [
        'A module outside the gateway reaches a provider directly.',
        '',
        'I15/D-005: all LLM calls route through one gateway so cost, retries and',
        'the audit trail cannot be bypassed. Use LLMGateway.complete().',
      ].join('\n'),
    ).toEqual([]);
  });

  itSdk('the vendor list is not vacuous: the gateway trees DO import a provider SDK', () => {
    // If this ever came back empty the guard would be measuring nothing —
    // §12.4d, "directory is not proof".
    const inside = (listSourceFiles([API_SRC_DIR]) as SourceFile[])
      .filter((f) => inGatewayTree(f.rel))
      .filter((f) => f.code.split('\n').some((l) => importSpecifiers(l).some(isProviderPackage)));
    expectSdk(inside.length).toBeGreaterThan(0);
  });

  itSdk('NEGATIVE CONTROL — a planted `@anthropic-ai/sdk` import fails (the exact caveat the PRD names)', () => {
    const dir = plantTree('i15-anthropic', {
      'planted-anthropic.ts': [
        "import Anthropic from '@anthropic-ai/sdk';",
        "const client = new Anthropic({ apiKey: 'x' });",
        "export const run = () => client.messages.create({ model: 'claude', messages: [] } as never);",
        '',
      ].join('\n'),
    });
    try {
      const found = providerBypassesOutsideGateway([dir]);
      expectSdk(found.map((f) => f.kind)).toContain('sdk-import');
      expectSdk(found.map((f) => f.detail)).toContain('@anthropic-ai/sdk');
      expectSdk(found.map((f) => f.detail)).toContain('anthropic');
    } finally {
      removeTree(dir);
    }
  });

  itSdk('NEGATIVE CONTROL — every listed vendor SDK is caught, not just the two the repo has heard of', () => {
    for (const pkg of PROVIDER_SDK_PACKAGES) {
      const dir = plantTree('i15-vendor', {
        'planted.ts': [`import x from '${pkg}';`, 'export default x;', ''].join('\n'),
      });
      try {
        const found = providerBypassesOutsideGateway([dir]);
        expectSdk(found.map((f) => f.detail), pkg).toContain(pkg);
      } finally {
        removeTree(dir);
      }
    }
  });

  itSdk('NEGATIVE CONTROL — an SDK-free fetch to a provider endpoint fails too', () => {
    const dir = plantTree('i15-fetch', {
      'planted-fetch.ts': [
        'export async function complete(prompt: string) {',
        "  const res = await fetch('https://api.anthropic.com/v1/messages', {",
        "    method: 'POST',",
        '    body: JSON.stringify({ prompt }),',
        '  });',
        '  return res.json();',
        '}',
        '',
      ].join('\n'),
    });
    try {
      const found = providerBypassesOutsideGateway([dir]);
      expectSdk(found.map((f) => f.kind)).toContain('http-endpoint');
      expectSdk(found.map((f) => f.detail)).toContain('api.anthropic.com');
    } finally {
      removeTree(dir);
    }
  });

  itSdk('NEGATIVE CONTROL (inverse) — a relative import of the repo\'s own ai/ tree is NOT mistaken for the `ai` package', () => {
    const dir = plantTree('i15-relative', {
      'consumer.ts': [
        "import { LLMGateway } from '../ai/gateway';",
        "import { buildContext } from './ai/orchestration/context-builder';",
        'export const g = LLMGateway;',
        'export const b = buildContext;',
        '',
      ].join('\n'),
    });
    try {
      expectSdk(providerBypassesOutsideGateway([dir])).toEqual([]);
    } finally {
      removeTree(dir);
    }
  });

  itSdk('the speech exclusion is narrow: a chat completion on the SAME host still fails', () => {
    const dir = plantTree('i15-same-host', {
      'speech.ts': [
        "export const tts = () => fetch('https://api.openai.com/v1/audio/speech');",
        '',
      ].join('\n'),
      'completion.ts': [
        "export const chat = () => fetch('https://api.openai.com/v1/chat/completions');",
        '',
      ].join('\n'),
    });
    try {
      const found = providerBypassesOutsideGateway([dir]);
      expectSdk(found).toHaveLength(1);
      expectSdk(found[0].at).toMatch(/completion\.ts:1$/);
    } finally {
      removeTree(dir);
    }
  });

  itSdk('the three speech call sites this exclusion covers are still exactly those three', () => {
    // Named so the exclusion cannot quietly grow: a fourth vendor-host fetch
    // that happens to sit under /v1/audio/ still shows up in review here.
    const speechSites = (listSourceFiles([API_SRC_DIR]) as SourceFile[])
      .filter((f) => !inGatewayTree(f.rel))
      .flatMap((f) =>
        f.code
          .split('\n')
          .map((l, i) => ({ l, at: `${f.rel}:${i + 1}` }))
          .filter(
            (x) =>
              PROVIDER_ENDPOINTS.some((e) => x.l.includes(e)) &&
              NON_LLM_VENDOR_PATHS.some((p) => x.l.includes(p)),
          ),
      )
      .map((x) => x.at);
    expectSdk(speechSites.sort()).toEqual([
      'src/ai/tts/tts-provider.ts:94',
      'src/voice/transcription-providers.ts:166',
      'src/voice/voice-service.ts:263',
    ]);
  });

  itSdk('NEGATIVE CONTROL (inverse) — a provider SDK named only in a doc comment is NOT reported', () => {
    const dir = plantTree('i15-comment-only', {
      'commented.ts': [
        '/**',
        " * Do not `import Anthropic from '@anthropic-ai/sdk'` here — every call",
        ' * goes through LLMGateway.complete() (D-005).',
        ' */',
        'export const ok = true;',
        '',
      ].join('\n'),
    });
    try {
      expectSdk(providerBypassesOutsideGateway([dir])).toEqual([]);
    } finally {
      removeTree(dir);
    }
  });
});
