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
  cassetteFallbackAllowedFromEnv,
  defaultCassettesDir,
  pickNewestRecording,
  type CassetteFile,
  type CassetteEntry,
} from '../../src/ai/voice-quality/cassette-gateway';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import type { LLMRequest, LLMResponse } from '../../src/ai/gateway/gateway';

function makeRequest(
  overrides: Partial<LLMRequest> = {}
): LLMRequest {
  return {
    // classify_intent is tenant-scoped; the gateway enforces a top-level
    // tenantId in strict (test/CI) mode. Record-mode passes through to the
    // real gateway, so supply one. tenantId is NOT part of the cassette hash
    // (snapshotRequest keys on model+prompt+schema only), so replay matches
    // are unaffected.
    tenantId: 'system',
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

/**
 * Build a minimal CassetteEntry for the pure-selector unit tests. `marker`
 * is round-tripped through the response content so a test can identify which
 * entry was chosen; `promptLen` lets a test pin that selection ignores prompt
 * size (it is keyed on recordedAt, not prompt similarity).
 */
function makeEntry(recordedAt: string, marker: string, promptLen = 100): CassetteEntry {
  const response: LLMResponse = {
    content: JSON.stringify({ marker }),
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 0, output: 0, total: 0 },
    latencyMs: 0,
  };
  return {
    requestHash: `sha256:${marker}`,
    request: { model: 'mock', prompt: 'x'.repeat(promptLen), schema: 'json' },
    response,
    tokenUsage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
    recordedAt,
  };
}

const markerOf = (e: CassetteEntry): string => JSON.parse(e.response.content).marker;

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
      /cassette drift/
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
    // but the fallback should return the recorded response. The loose drift
    // fallback is opt-in now (strict-by-default); enable it explicitly.
    const replayer = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'replay',
      allowFallback: true,
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
    // though both entries share the user transcript + schema. Loose fallback
    // is opt-in (strict-by-default); enable it explicitly.
    const replayer = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'replay',
      allowFallback: true,
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

  it('drift fallback — replays the newest recording for the same logical call, deterministically', async () => {
    // Models the real corpus pathology: one (schema, system-fp, user) key
    // accrues several recordings as the classifier system prompt is
    // re-recorded over time. An OLD recording carries a now-stale response;
    // a NEWER recording carries the current one. On a hash-miss the fallback
    // must replay the NEWEST recording (by recordedAt) — not matches[0] by
    // file order — and do so identically on every call (no consumption
    // counter). The live prompt here only serves to force the hash-miss;
    // selection is by recordedAt, so the later-recorded entry wins.
    const scriptId = 'drift-newest-recording';
    const { gateway: realGateway, provider } = createMockLLMGateway();
    const user = 'reschedule my Tuesday appointment to Wednesday at the same time';
    const recorder = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'record',
      realGateway,
    });

    // OLD recording (file index 0): short prompt, STALE/vague response.
    provider.setDefaultResponse(
      '{"intentType":"reschedule_appointment","newDateTimeDescription":"the requested new time"}',
    );
    await recorder.complete(
      makeRequest({
        messages: [
          { role: 'system', content: 'You are an intent classifier. Intents: book, cancel.' },
          { role: 'user', content: user },
        ],
      }),
    );

    // NEW recording (file index 1): longer prompt (intents appended), the
    // CURRENT concrete response. Shares the classifier first-sentence
    // fingerprint with the old one, so both land in the fallback match set.
    provider.setDefaultResponse(
      '{"intentType":"reschedule_appointment","newDateTimeDescription":"May 13 2026 2:00 PM"}',
    );
    await recorder.complete(
      makeRequest({
        messages: [
          {
            role: 'system',
            content:
              'You are an intent classifier. Intents: book, cancel, reschedule, lookup, confirm, escalate, transfer, voicemail.',
          },
          { role: 'user', content: user },
        ],
      }),
    );

    // LIVE request: a further-drifted prompt, so it hash-misses BOTH
    // recordings and falls through to the newest-recording selection. Loose
    // fallback is opt-in (strict-by-default); enable it explicitly.
    const replayer = new CassetteLLMGateway({
      scriptId,
      cassettesDir: tempDir,
      mode: 'replay',
      allowFallback: true,
    });
    const drifted = makeRequest({
      messages: [
        {
          role: 'system',
          content:
            'You are an intent classifier. Intents: book, cancel, reschedule, lookup, confirm, escalate, transfer, voicemail, complaint.',
        },
        { role: 'user', content: user },
      ],
    });

    const a = await replayer.complete(drifted);
    const b = await replayer.complete(drifted);
    const c = await replayer.complete(drifted);
    // The fallback returns the NEWEST recording (concrete value), not the
    // older stale one ("the requested new time")...
    expect(JSON.parse(a.content).newDateTimeDescription).toBe('May 13 2026 2:00 PM');
    // ...deterministically across repeated calls (no positional walk).
    expect(b.content).toBe(a.content);
    expect(c.content).toBe(a.content);
  });

  describe('pickNewestRecording — drift fallback selection', () => {
    // The match set reaching this selector is already narrowed to one
    // logical call's refresh history (same schema + system fingerprint +
    // user); these tests pin the pure ranking contract directly, including
    // the branches the end-to-end replay test cannot reach.

    it('returns the newest recordedAt regardless of array position (in-place refresh case)', () => {
      // The current recording sits at index 0 — e.g. a `refresh` overwrote it
      // in place, bumping its timestamp without moving it — while longer,
      // older recordings follow. Selection by file order OR prompt length
      // would wrongly pick a later/longer entry; recordedAt pins the current.
      const matches: CassetteEntry[] = [
        makeEntry('2026-06-14T12:00:00.000Z', 'current', 50),
        makeEntry('2026-05-01T00:00:00.000Z', 'stale-a', 9000),
        makeEntry('2026-05-20T00:00:00.000Z', 'stale-b', 9000),
      ];
      expect(markerOf(pickNewestRecording(matches))).toBe('current');
    });

    it('is order-independent: any permutation of distinct timestamps yields the same pick', () => {
      const a = makeEntry('2026-01-01T00:00:00.000Z', 'old');
      const b = makeEntry('2026-03-01T00:00:00.000Z', 'mid');
      const c = makeEntry('2026-06-01T00:00:00.000Z', 'new');
      expect(markerOf(pickNewestRecording([a, b, c]))).toBe('new');
      expect(markerOf(pickNewestRecording([c, a, b]))).toBe('new');
      expect(markerOf(pickNewestRecording([b, c, a]))).toBe('new');
    });

    it('breaks an equal-recordedAt tie by preferring the later (newer) array entry, deterministically', () => {
      const ts = '2026-06-01T00:00:00.000Z';
      const matches: CassetteEntry[] = [
        makeEntry(ts, 'first'),
        makeEntry(ts, 'second'),
        makeEntry(ts, 'third'),
      ];
      // Later index wins on a full timestamp tie, and repeats identically
      // (pure function, no per-instance counter).
      expect(markerOf(pickNewestRecording(matches))).toBe('third');
      expect(markerOf(pickNewestRecording(matches))).toBe('third');
    });

    it('ignores prompt size — a shorter, older-prompt entry with a newer recordedAt still wins', () => {
      // Guards against regressing to a prompt-similarity selector: the newer
      // recording here has the far SHORTER prompt.
      const matches: CassetteEntry[] = [
        makeEntry('2026-05-01T00:00:00.000Z', 'long-old', 20000),
        makeEntry('2026-06-01T00:00:00.000Z', 'short-new', 80),
      ];
      expect(markerOf(pickNewestRecording(matches))).toBe('short-new');
    });

    it('returns the sole entry when the match set has one element', () => {
      const only = makeEntry('2026-06-01T00:00:00.000Z', 'only');
      expect(pickNewestRecording([only])).toBe(only);
    });
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
      /cassette drift: scriptId=partial-cassette/
    );
  });

  describe('strict drift mode (VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK)', () => {
    // Records one entry under an OLD prompt, then replays a same-transcript
    // request under a DRIFTED (extended) prompt that hash-misses but WOULD
    // loose-match. Proves: default = hard failure; flag = loose match.
    async function recordDrift(scriptId: string): Promise<{ drifted: LLMRequest }> {
      const { gateway: realGateway, provider } = createMockLLMGateway();
      provider.setDefaultResponse('{"intentType":"create_appointment","confidence":0.9}');
      const recorder = new CassetteLLMGateway({
        scriptId, cassettesDir: tempDir, mode: 'record', realGateway,
      });
      await recorder.complete(makeRequest({
        messages: [
          { role: 'system', content: 'You are an intent classifier for ServiceOS.' },
          { role: 'user', content: 'schedule a visit next Tuesday at 2pm' },
        ],
      }));
      const drifted = makeRequest({
        messages: [
          { role: 'system', content: 'You are an intent classifier for ServiceOS. Many new intents appended since recording.' },
          { role: 'user', content: 'schedule a visit next Tuesday at 2pm' },
        ],
      });
      return { drifted };
    }

    it('DEFAULT: a hash miss is a hard failure even when a loose match exists', async () => {
      const { drifted } = await recordDrift('strict-default-drift');
      const replayer = new CassetteLLMGateway({
        scriptId: 'strict-default-drift', cassettesDir: tempDir, mode: 'replay',
        // allowFallback omitted → strict (env flag is unset in this suite).
      });
      await expect(replayer.complete(drifted)).rejects.toThrow(
        /cassette drift[\s\S]*voice-quality:refresh/
      );
    });

    it('FLAG (allowFallback:true): a hash miss loose-matches and serves the recording', async () => {
      const { drifted } = await recordDrift('strict-flag-drift');
      const replayer = new CassetteLLMGateway({
        scriptId: 'strict-flag-drift', cassettesDir: tempDir, mode: 'replay',
        allowFallback: true,
      });
      const res = await replayer.complete(drifted);
      expect(res.content).toBe('{"intentType":"create_appointment","confidence":0.9}');
    });

    it('cassetteFallbackAllowedFromEnv reads VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK', () => {
      const prev = process.env.VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK;
      try {
        delete process.env.VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK;
        expect(cassetteFallbackAllowedFromEnv()).toBe(false);
        process.env.VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK = '1';
        expect(cassetteFallbackAllowedFromEnv()).toBe(true);
        process.env.VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK = 'true';
        expect(cassetteFallbackAllowedFromEnv()).toBe(true);
        process.env.VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK = '0';
        expect(cassetteFallbackAllowedFromEnv()).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK;
        else process.env.VOICE_QUALITY_ALLOW_CASSETTE_FALLBACK = prev;
      }
    });
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
