/**
 * VQ-005 — CassetteLLMGateway tests.
 *
 * The CassetteLLMGateway extends `LLMGateway` and intercepts `complete()`
 * to either replay from a recorded cassette file (default in CI), record
 * a new entry by passing through to a real gateway, or refresh (overwrite)
 * existing entries. Cassettes are JSON files keyed by scriptId.
 *
 * Tests use Node's `os.tmpdir()` for cassette I/O so the real corpus
 * directory is never written from a unit test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  CassetteLLMGateway,
  defaultCassettesDir,
  type CassetteFile,
} from '../../src/ai/voice-quality/cassette-gateway';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import type { LLMRequest } from '../../src/ai/gateway/gateway';

function makeRequest(
  overrides: Partial<LLMRequest> = {}
): LLMRequest {
  return {
    taskType: 'classify_intent',
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'you are a router' },
      { role: 'user', content: 'book me an appointment' },
    ],
    responseFormat: 'json',
    ...overrides,
  };
}

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `vq-cassette-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readCassette(dir: string, scriptId: string): CassetteFile {
  const raw = fs.readFileSync(path.join(dir, `${scriptId}.json`), 'utf-8');
  return JSON.parse(raw) as CassetteFile;
}

function writeCassette(dir: string, scriptId: string, contents: CassetteFile): void {
  fs.writeFileSync(path.join(dir, `${scriptId}.json`), JSON.stringify(contents, null, 2));
}

describe('VQ-005 — CassetteLLMGateway', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('VQ-005 — defaultCassettesDir resolves to the corpus/cassettes path', () => {
    const dir = defaultCassettesDir();
    expect(dir.endsWith(path.join('voice-quality', 'corpus', 'cassettes'))).toBe(true);
  });

  it('VQ-005 — replay mode reads existing cassette + matches by hash + returns recorded response', async () => {
    const scriptId = 'happy-booker-create';
    const request = makeRequest();
    // Pre-compute the hash via a recording gateway, then re-use it for replay.
    const { gateway: realGateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('{"intentType":"create_appointment","confidence":0.9}');
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });
    await recorder.complete(request);

    // Now replay
    const replayer = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'replay',
    });
    const response = await replayer.complete(request);
    expect(response.content).toBe('{"intentType":"create_appointment","confidence":0.9}');
    expect(response.provider).toBe('mock');
  });

  it('VQ-005 — replay mode throws clear error on cache miss', async () => {
    const scriptId = 'nonexistent-script';
    const replayer = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'replay',
    });
    await expect(replayer.complete(makeRequest())).rejects.toThrow(
      /cassette stale, refresh needed/
    );
  });

  it('drift fallback — system-prompt extension misses hash but recovers via user-content match', async () => {
    // Record a cassette under the OLD system prompt.
    const scriptId = 'drift-system-extended';
    const { gateway: realGateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('{"intentType":"create_appointment","confidence":0.9}');
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });
    await recorder.complete(
      makeRequest({
        messages: [
          { role: 'system', content: 'You are an intent classifier for ServiceOS.' },
          { role: 'user', content: 'I want to schedule an appointment for next Tuesday at 2pm.' },
        ],
      }),
    );

    // Replay with an EXTENDED system prompt (same transcript) — hash misses
    // but the fallback should return the recorded response.
    const replayer = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'replay',
    });
    const driftedRequest = makeRequest({
      messages: [
        {
          role: 'system',
          content:
            'You are an intent classifier for ServiceOS. Supported intents: …(many new intents added since recording)…',
        },
        { role: 'user', content: 'I want to schedule an appointment for next Tuesday at 2pm.' },
      ],
    });
    const response = await replayer.complete(driftedRequest);
    expect(response.content).toBe('{"intentType":"create_appointment","confidence":0.9}');
  });

  it('drift fallback — system-prompt fingerprint differentiates classifier vs slot extractor', async () => {
    const scriptId = 'drift-system-fp-disambiguates';
    const { gateway: realGateway, provider } = createMockLLMGateway();

    // Record TWO entries with the SAME schema + same user transcript but
    // different system prompts. This is the realistic shape: intent
    // classifier + slot extractor both fire on one user utterance.
    const transcript = 'Reschedule the Davis appointment to next Monday at 3pm.';
    provider.setDefaultResponse('{"intentType":"reschedule_appointment"}');
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });
    await recorder.complete(
      makeRequest({
        messages: [
          { role: 'system', content: 'You are an intent classifier for ServiceOS.' },
          { role: 'user', content: transcript },
        ],
      }),
    );
    provider.setDefaultResponse(
      '{"newScheduledStart":"2026-06-22T20:00:00.000Z","newScheduledEnd":"2026-06-22T21:00:00.000Z"}',
    );
    await recorder.complete(
      makeRequest({
        messages: [
          { role: 'system', content: 'You are an appointment scheduling assistant for ServiceOS.' },
          { role: 'user', content: transcript },
        ],
      }),
    );

    // Replay with drifted system prompts. The slot-extractor fallback
    // must return the SLOT response, not the intent response, even
    // though both entries share the user transcript + schema.
    const replayer = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'replay',
    });
    const slotRequest = makeRequest({
      messages: [
        {
          role: 'system',
          content:
            'You are an appointment scheduling assistant for ServiceOS. New rule appended after recording: never assume the current year.',
        },
        { role: 'user', content: transcript },
      ],
    });
    const response = await replayer.complete(slotRequest);
    expect(response.content).toContain('newScheduledStart');
    expect(response.content).not.toContain('intentType');
  });

  it('drift fallback — multiple matches with same fingerprint walk in recorded order', async () => {
    const scriptId = 'drift-fallback-counter';
    const { gateway: realGateway, provider } = createMockLLMGateway();

    // Record three classifier calls with the same system+user — modeling
    // a multi-turn script that re-classifies. Each recorded response is
    // distinct so we can prove the Nth replay returns the Nth recording.
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });
    // Vary the model each round so the recorded hashes are distinct
    // (the cassette dedups on hash collision); the fallback ignores
    // model entirely so all three entries still match the same
    // (schema, system-fp, user) key.
    for (const [tag, model] of [
      ['first', 'm1'],
      ['second', 'm2'],
      ['third', 'm3'],
    ] as const) {
      provider.setDefaultResponse(`{"tag":"${tag}"}`);
      await recorder.complete(
        makeRequest({
          model,
          messages: [
            { role: 'system', content: 'You are an intent classifier.' },
            { role: 'user', content: 'classify me' },
          ],
        }),
      );
    }

    // Replay each fallback hit in turn and assert the order.
    const replayer = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'replay',
    });
    const driftedRequest = makeRequest({
      messages: [
        {
          role: 'system',
          content: 'You are an intent classifier. NEW: extra paragraph added after recording.',
        },
        { role: 'user', content: 'classify me' },
      ],
    });
    const a = await replayer.complete(driftedRequest);
    const b = await replayer.complete(driftedRequest);
    const c = await replayer.complete(driftedRequest);
    expect(JSON.parse(a.content)).toEqual({ tag: 'first' });
    expect(JSON.parse(b.content)).toEqual({ tag: 'second' });
    expect(JSON.parse(c.content)).toEqual({ tag: 'third' });
  });

  it('VQ-005 — replay mode raises a clear error if cassette file exists but the request hash is not in it', async () => {
    const scriptId = 'partial-cassette';
    writeCassette(tempDir, scriptId, {
      scriptId,
      version: 1,
      rubricVersion: 'v1',
      entries: [
        {
          requestHash: 'sha256:not-the-one',
          request: { model: 'x', prompt: 'y', schema: 'z' },
          response: {
            content: 'old',
            model: 'x',
            provider: 'mock',
            tokenUsage: { input: 0, output: 0, total: 0 },
            latencyMs: 0,
          },
          tokenUsage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
          recordedAt: new Date().toISOString(),
        },
      ],
    });
    const replayer = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'replay',
    });
    await expect(replayer.complete(makeRequest())).rejects.toThrow(
      /cassette stale, refresh needed for scriptId=partial-cassette/
    );
  });

  it('VQ-005 — record mode writes new entry to cassette + returns real response', async () => {
    const scriptId = 'record-test';
    const { gateway: realGateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('{"hello":"world"}');
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });
    const response = await recorder.complete(makeRequest());
    expect(response.content).toBe('{"hello":"world"}');

    const cassette = readCassette(tempDir, scriptId);
    expect(cassette.scriptId).toBe(scriptId);
    expect(cassette.version).toBe(1);
    expect(cassette.rubricVersion).toBe('v1');
    expect(cassette.entries).toHaveLength(1);
    expect(cassette.entries[0]!.requestHash).toMatch(/^sha256:/);
    expect(cassette.entries[0]!.response.content).toBe('{"hello":"world"}');
  });

  it('VQ-005 — record mode is idempotent (same request twice = one entry)', async () => {
    const scriptId = 'idempotent-test';
    const { gateway: realGateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('{"v":1}');
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });
    await recorder.complete(makeRequest());

    // Second call: change the underlying response, make the same request,
    // and confirm the cassette was NOT overwritten (idempotent record).
    provider.setDefaultResponse('{"v":2}');
    await recorder.complete(makeRequest());

    const cassette = readCassette(tempDir, scriptId);
    expect(cassette.entries).toHaveLength(1);
    expect(cassette.entries[0]!.response.content).toBe('{"v":1}');
  });

  it('VQ-005 — refresh mode overwrites existing entry with new response', async () => {
    const scriptId = 'refresh-test';
    const { gateway: realGateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('{"v":1}');
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });
    await recorder.complete(makeRequest());

    provider.setDefaultResponse('{"v":2}');
    const refresher = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'refresh',
      realGateway,
    });
    await refresher.complete(makeRequest());

    const cassette = readCassette(tempDir, scriptId);
    expect(cassette.entries).toHaveLength(1);
    expect(cassette.entries[0]!.response.content).toBe('{"v":2}');
  });

  it('VQ-005 — record mode preserves earlier entries when a new request is added', async () => {
    const scriptId = 'multi-entry-test';
    const { gateway: realGateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('{"first":true}');
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });
    await recorder.complete(makeRequest());

    provider.setDefaultResponse('{"second":true}');
    await recorder.complete(makeRequest({ messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'something else entirely' },
    ] }));

    const cassette = readCassette(tempDir, scriptId);
    expect(cassette.entries).toHaveLength(2);
  });

  it('VQ-005 — request hash is stable across object-key reordering', async () => {
    const scriptId = 'hash-stability-test';
    const { gateway: realGateway, provider } = createMockLLMGateway();
    provider.setDefaultResponse('{"v":1}');
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });

    // Same logical request, but with object keys deliberately reordered.
    const reqA: LLMRequest = {
      taskType: 'x',
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'a' },
        { role: 'user', content: 'b' },
      ],
      responseFormat: 'json',
    };
    const reqB: LLMRequest = {
      responseFormat: 'json',
      messages: [
        { content: 'a', role: 'system' },
        { content: 'b', role: 'user' },
      ],
      model: 'gpt-4o-mini',
      taskType: 'x',
    };

    await recorder.complete(reqA);
    await recorder.complete(reqB);

    const cassette = readCassette(tempDir, scriptId);
    expect(cassette.entries).toHaveLength(1);
  });

  it('VQ-005 — record mode requires realGateway', async () => {
    const scriptId = 'no-real-gateway';
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
    });
    await expect(recorder.complete(makeRequest())).rejects.toThrow(
      /realGateway is required/
    );
  });

  it('VQ-005 — refresh mode requires realGateway', async () => {
    const scriptId = 'no-real-gateway-refresh';
    const refresher = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'refresh',
    });
    await expect(refresher.complete(makeRequest())).rejects.toThrow(
      /realGateway is required/
    );
  });

  it.todo(
    'VQ-005 — file lock: simulating concurrent record acquires lock + serializes (not deterministic; deferred — see jsdoc on acquireLock)'
  );
});
