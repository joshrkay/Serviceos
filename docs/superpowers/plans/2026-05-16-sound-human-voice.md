# Sound Human — Calling Agent Pacing & Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbound AI calling agent sound indistinguishable from a human receptionist by removing 400–800ms of TTS buffering latency, masking LLM processing gaps with backchannel fillers, tuning STT endpointing for HVAC/plumbing vocabulary, and replacing generic "what?" reprompts with structured vertical-aware repair turns.

**Architecture:** Five independent feature areas layered on top of the existing Twilio Media Streams + Deepgram + FSM voice pipeline. F3 swaps the buffered ElevenLabs REST call for a WebSocket streaming variant. P2-2 enriches the Deepgram WS URL with vertical keyword boost. P2-4 is a one-line greeting template change. P2-3 routes low-confidence intent-capture turns through vertical-aware repair templates living in the existing vertical packs. P2-1 adds a 250ms filler timer wrapping `emitSideEffects` in the media-streams adapter, with pre-rendered PCM clips loaded at boot.

**Tech Stack:** TypeScript, Node 22, Vitest, Twilio Media Streams, Deepgram Nova-3 (WebSocket), ElevenLabs WebSocket TTS (`/v1/text-to-speech/{voice_id}/stream-input`), OpenAI TTS (fallback). All code lives under `packages/api/src/`.

**Spec:** [docs/superpowers/specs/2026-05-16-sound-human-voice-design.md](../specs/2026-05-16-sound-human-voice-design.md)

---

## File Structure

| Path | Responsibility | Status |
|---|---|---|
| `packages/api/src/ai/tts/tts-provider.ts` | TtsProvider interface + OpenAI/ElevenLabs REST impls | Modify — add `synthesizeStream` |
| `packages/api/src/ai/tts/elevenlabs-stream.ts` | WebSocket streaming connection helper | Create |
| `packages/api/src/voice/transcription-providers.ts` | Deepgram WS URL builder + provider | Modify — accept keywords + endpointing override |
| `packages/api/src/voice/vertical-terminology-provider.ts` | Resolve keyword list for active tenant pack | Create |
| `packages/api/src/verticals/packs/hvac.ts` | HVAC pack | Modify — add `sttKeywords` array |
| `packages/api/src/verticals/packs/plumbing.ts` | Plumbing pack | Modify — add `sttKeywords` array |
| `packages/api/src/verticals/packs/electrical.ts` | Electrical pack | Modify — add `sttKeywords` array |
| `packages/api/src/verticals/registry.ts` | VerticalPack interface + repository | Modify — extend type with `sttKeywords?` and `repairTemplates?` |
| `packages/api/src/ai/agents/customer-calling/repair-templates.ts` | Choose repair turn text from partial context | Create |
| `packages/api/src/ai/agents/customer-calling/transitions.ts` | FSM transition table | Modify — low-confidence path consults repair-templates |
| `packages/api/src/ai/agents/customer-calling/filler-engine.ts` | Pre-rendered filler library + 250ms timer + cancellation | Create |
| `packages/api/src/ai/agents/customer-calling/fillers/` | Pre-rendered PCM filler audio (8 files) | Create directory + assets |
| `packages/api/src/telephony/media-streams/mediastream-adapter.ts` | Per-WS adapter | Modify — consume streaming TTS; wrap `emitSideEffects` with filler |
| `packages/api/src/telephony/twilio-adapter.ts` | TwiML + greeting builder | Modify — greeting ends with prompt cue |
| `packages/api/src/ai/voice-quality/events.ts` | VoiceSessionEvent variants | Modify — add `filler_fired`, `filler_cancelled`, `repair_template_fired` |
| `scripts/render-fillers.ts` | Deploy-time script that synthesizes filler library to PCM files | Create |
| `packages/api/test/ai/tts/elevenlabs-stream.test.ts` | Stream provider tests | Create |
| `packages/api/test/voice/vertical-terminology-provider.test.ts` | Keyword resolver tests | Create |
| `packages/api/test/voice/transcription-providers.test.ts` | Deepgram URL builder tests | Modify or create |
| `packages/api/test/ai/agents/customer-calling/repair-templates.test.ts` | Repair selector tests | Create |
| `packages/api/test/ai/agents/customer-calling/transitions.test.ts` | FSM low-confidence path tests | Modify or create |
| `packages/api/test/ai/agents/customer-calling/filler-engine.test.ts` | Filler engine race tests | Create |
| `packages/api/test/telephony/media-streams/mediastream-adapter.test.ts` | Streaming TTS + filler integration | Modify |
| `packages/api/test/telephony/twilio-adapter.test.ts` | Greeting cue test | Modify or create |

---

## Section 0 — Setup

### Task 0.1: Create feature branch + verify pre-flight

**Files:** none

- [ ] **Step 1: Create branch from main**

```bash
cd /Users/macmini/Serviceos/Serviceos
git checkout main
git pull origin main
git checkout -b feat/sound-human-voice
```

- [ ] **Step 2: Verify build is green before any changes**

```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Verify test runner works**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run --reporter=dot test/ai/tts
```

Expected: existing tests pass (or zero matches — confirm runner output is clean).

- [ ] **Step 4: Commit the spec + plan + branch start**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add docs/superpowers/specs/2026-05-16-sound-human-voice-design.md docs/superpowers/plans/2026-05-16-sound-human-voice.md
git commit -m "docs(voice): add Sound Human spec + implementation plan"
```

---

## Section 1 — F3: ElevenLabs WebSocket Streaming TTS

### Task 1.1: Extend `TtsProvider` interface with optional `synthesizeStream`

**Files:**
- Modify: `packages/api/src/ai/tts/tts-provider.ts`

- [ ] **Step 1: Add streaming types to the file**

Open `packages/api/src/ai/tts/tts-provider.ts` and add **above** the `TtsProvider` interface (around line 42):

```typescript
export interface TtsStreamChunk {
  /** PCM 16-bit signed little-endian @ 16 kHz mono. */
  pcm: Buffer;
  /** True on the final chunk; the iterator MUST yield one chunk with isFinal=true even if empty. */
  isFinal: boolean;
}

export interface TtsSynthesizeStreamInput extends TtsSynthesizeInput {
  /**
   * Aborted by the caller when caller barges in mid-utterance. Stream
   * iterators MUST stop yielding promptly when this fires.
   */
  signal?: AbortSignal;
}
```

- [ ] **Step 2: Extend `TtsProvider` with optional `synthesizeStream`**

In the same file, replace the existing `TtsProvider` interface (lines 42-44) with:

```typescript
export interface TtsProvider {
  synthesize(input: TtsSynthesizeInput): Promise<TtsSynthesizeResult>;
  /**
   * Optional WebSocket-backed streaming variant. When present, the
   * media-streams adapter prefers it because it removes ~400-800ms of
   * pre-first-frame buffering.
   *
   * Implementations MUST yield at least one chunk (even if empty) with
   * isFinal=true so consumers can detect end-of-stream.
   */
  synthesizeStream?(input: TtsSynthesizeStreamInput): AsyncIterable<TtsStreamChunk>;
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors (interface extension is non-breaking — existing impls still satisfy the type because `synthesizeStream` is optional).

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/tts/tts-provider.ts
git commit -m "feat(tts): add optional synthesizeStream interface for WebSocket TTS"
```

---

### Task 1.2: Write failing test for `ElevenLabsStreamConnection`

**Files:**
- Create: `packages/api/test/ai/tts/elevenlabs-stream.test.ts`

- [ ] **Step 1: Create the test file**

Create `packages/api/test/ai/tts/elevenlabs-stream.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElevenLabsStreamConnection } from '../../../src/ai/tts/elevenlabs-stream';

// Minimal WebSocket fake matching the subset of WHATWG WebSocket the
// connection helper uses (open/message/close/error/send).
class FakeWs {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, Array<(e: unknown) => void>> = {};

  addEventListener(event: string, fn: (e: unknown) => void): void {
    (this.listeners[event] ??= []).push(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.fire('close', {});
  }
  fire(event: string, payload: unknown): void {
    for (const fn of this.listeners[event] ?? []) fn(payload);
  }
}

describe('ElevenLabsStreamConnection', () => {
  let ws: FakeWs;
  let originalWebSocket: typeof WebSocket;

  beforeEach(() => {
    ws = new FakeWs();
    originalWebSocket = global.WebSocket;
    global.WebSocket = vi.fn(() => {
      // Open asynchronously to mirror real WHATWG behavior.
      queueMicrotask(() => {
        ws.readyState = FakeWs.OPEN;
        ws.fire('open', {});
      });
      return ws as unknown as WebSocket;
    }) as unknown as typeof WebSocket;
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  it('opens a WebSocket with the configured voice id and api key', async () => {
    const conn = new ElevenLabsStreamConnection({
      apiKey: 'key-123',
      voiceId: 'voice-abc',
      modelId: 'eleven_turbo_v2_5',
    });
    const iter = conn.synthesize({ text: 'hello' })[Symbol.asyncIterator]();
    // Allow the queued microtask to fire `open`.
    await Promise.resolve();
    expect(global.WebSocket).toHaveBeenCalledWith(
      expect.stringContaining('voice-abc')
    );
    expect(global.WebSocket).toHaveBeenCalledWith(
      expect.stringContaining('xi-api-key=key-123')
    );
    // Close cleanly so the iterator resolves.
    ws.close();
    const next = await iter.next();
    expect(next.done).toBe(true);
  });

  it('yields PCM chunks for inbound audio frames and ends with isFinal=true', async () => {
    const conn = new ElevenLabsStreamConnection({
      apiKey: 'k',
      voiceId: 'v',
      modelId: 'm',
    });
    const stream = conn.synthesize({ text: 'hi there' });
    const chunks: Array<{ pcm: Buffer; isFinal: boolean }> = [];
    const collect = (async () => {
      for await (const c of stream) chunks.push(c);
    })();

    // Wait for open then push two audio frames + isFinal.
    await Promise.resolve();
    const audio = Buffer.from([1, 2, 3, 4]).toString('base64');
    ws.fire('message', { data: JSON.stringify({ audio }) });
    ws.fire('message', { data: JSON.stringify({ audio }) });
    ws.fire('message', { data: JSON.stringify({ isFinal: true }) });
    ws.close();

    await collect;
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[chunks.length - 1].isFinal).toBe(true);
    expect(chunks[0].pcm.length).toBe(4);
  });

  it('aborts mid-stream when the caller signal fires', async () => {
    const controller = new AbortController();
    const conn = new ElevenLabsStreamConnection({
      apiKey: 'k',
      voiceId: 'v',
      modelId: 'm',
    });
    const stream = conn.synthesize({ text: 'long sentence', signal: controller.signal });
    const collect = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of stream) {
        controller.abort();
      }
    })();
    await Promise.resolve();
    const audio = Buffer.from([1, 2]).toString('base64');
    ws.fire('message', { data: JSON.stringify({ audio }) });
    await collect;
    expect(ws.readyState).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/ai/tts/elevenlabs-stream.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/ai/tts/elevenlabs-stream'".

---

### Task 1.3: Implement `ElevenLabsStreamConnection`

**Files:**
- Create: `packages/api/src/ai/tts/elevenlabs-stream.ts`

- [ ] **Step 1: Create the implementation**

Create `packages/api/src/ai/tts/elevenlabs-stream.ts` with:

```typescript
import type { TtsStreamChunk, TtsSynthesizeStreamInput } from './tts-provider';

export interface ElevenLabsStreamConnectionOpts {
  apiKey: string;
  voiceId: string;
  modelId: string;
  /** Optional override for the WebSocket URL (used in tests). */
  baseUrl?: string;
}

/**
 * Thin wrapper over the ElevenLabs WebSocket streaming TTS endpoint.
 *
 * Endpoint: wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
 *
 * Audio frames arrive as JSON messages of shape `{ audio: <base64 pcm> }`
 * or `{ isFinal: true }`. We yield each base64 frame as a Buffer in a PCM
 * stream chunk and emit a final `isFinal=true` chunk when the upstream
 * signals end-of-stream OR the WebSocket closes.
 *
 * The caller can abort mid-stream by passing an AbortSignal — this closes
 * the WebSocket immediately so we stop paying for audio we will not play.
 */
export class ElevenLabsStreamConnection {
  private readonly baseUrl: string;

  constructor(private readonly opts: ElevenLabsStreamConnectionOpts) {
    this.baseUrl = opts.baseUrl ?? 'wss://api.elevenlabs.io';
  }

  synthesize(input: TtsSynthesizeStreamInput): AsyncIterable<TtsStreamChunk> {
    const { apiKey, voiceId, modelId } = this.opts;
    const baseUrl = this.baseUrl;
    return {
      [Symbol.asyncIterator]: () => this.openIterator(baseUrl, voiceId, apiKey, modelId, input),
    };
  }

  private openIterator(
    baseUrl: string,
    voiceId: string,
    apiKey: string,
    modelId: string,
    input: TtsSynthesizeStreamInput
  ): AsyncIterator<TtsStreamChunk> {
    const url =
      `${baseUrl.replace(/^http/, 'ws')}/v1/text-to-speech/${voiceId}/stream-input` +
      `?model_id=${modelId}&xi-api-key=${apiKey}`;
    const ws = new WebSocket(url);
    const queue: TtsStreamChunk[] = [];
    let done = false;
    let waiter: ((v: IteratorResult<TtsStreamChunk>) => void) | null = null;
    let errorState: Error | null = null;

    const push = (chunk: TtsStreamChunk): void => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: chunk, done: false });
      } else {
        queue.push(chunk);
      }
    };

    const finish = (): void => {
      if (done) return;
      done = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: undefined as unknown as TtsStreamChunk, done: true });
      }
    };

    ws.addEventListener('open', () => {
      // Send the text payload + an empty terminator per ElevenLabs WS protocol.
      ws.send(JSON.stringify({ text: input.text + ' ' }));
      ws.send(JSON.stringify({ text: '' }));
    });

    ws.addEventListener('message', (msg: MessageEvent) => {
      try {
        const data = JSON.parse(String(msg.data)) as {
          audio?: string;
          isFinal?: boolean;
        };
        if (data.audio) {
          push({ pcm: Buffer.from(data.audio, 'base64'), isFinal: false });
        }
        if (data.isFinal) {
          push({ pcm: Buffer.alloc(0), isFinal: true });
        }
      } catch {
        // Drop malformed frame.
      }
    });

    ws.addEventListener('error', () => {
      errorState = new Error('ElevenLabs WS error');
      try {
        ws.close();
      } catch {
        /* swallow */
      }
    });

    ws.addEventListener('close', () => {
      // If we never emitted a terminal isFinal, do so now.
      push({ pcm: Buffer.alloc(0), isFinal: true });
      finish();
    });

    input.signal?.addEventListener('abort', () => {
      try {
        ws.close();
      } catch {
        /* swallow */
      }
    });

    return {
      next: (): Promise<IteratorResult<TtsStreamChunk>> => {
        if (errorState) {
          const e = errorState;
          errorState = null;
          return Promise.reject(e);
        }
        const queued = queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (done) return Promise.resolve({ value: undefined as unknown as TtsStreamChunk, done: true });
        return new Promise((resolve) => {
          waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<TtsStreamChunk>> => {
        try {
          ws.close();
        } catch {
          /* swallow */
        }
        finish();
        return Promise.resolve({ value: undefined as unknown as TtsStreamChunk, done: true });
      },
    };
  }
}
```

- [ ] **Step 2: Run test**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/ai/tts/elevenlabs-stream.test.ts
```

Expected: PASS (all 3 tests).

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/tts/elevenlabs-stream.ts packages/api/test/ai/tts/elevenlabs-stream.test.ts
git commit -m "feat(tts): add ElevenLabsStreamConnection for WebSocket streaming TTS"
```

---

### Task 1.4: Wire `synthesizeStream` into `ElevenLabsTtsProvider`

**Files:**
- Modify: `packages/api/src/ai/tts/tts-provider.ts`

- [ ] **Step 1: Add import for the stream helper**

At the top of `packages/api/src/ai/tts/tts-provider.ts`, after existing imports (or as the first import if none), add:

```typescript
import { ElevenLabsStreamConnection } from './elevenlabs-stream';
```

- [ ] **Step 2: Add `synthesizeStream` method to `ElevenLabsTtsProvider`**

Inside the existing `ElevenLabsTtsProvider` class (after the existing `synthesize` method around line 140), add:

```typescript
synthesizeStream(input: import('./tts-provider').TtsSynthesizeStreamInput): AsyncIterable<import('./tts-provider').TtsStreamChunk> {
  const modelId =
    input.language === 'es' ? 'eleven_multilingual_v2' : this.modelId;
  const conn = new ElevenLabsStreamConnection({
    apiKey: this.apiKey,
    voiceId: this.voiceId,
    modelId,
  });
  return conn.synthesize(input);
}
```

Note: the `import('./tts-provider').` self-references are awkward inside the same file. Replace with bare names instead — since `TtsSynthesizeStreamInput` and `TtsStreamChunk` are declared in this same file, write:

```typescript
synthesizeStream(input: TtsSynthesizeStreamInput): AsyncIterable<TtsStreamChunk> {
  const modelId =
    input.language === 'es' ? 'eleven_multilingual_v2' : this.modelId;
  const conn = new ElevenLabsStreamConnection({
    apiKey: this.apiKey,
    voiceId: this.voiceId,
    modelId,
  });
  return conn.synthesize(input);
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Run all TTS tests**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/ai/tts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/tts/tts-provider.ts
git commit -m "feat(tts): expose synthesizeStream on ElevenLabsTtsProvider"
```

---

### Task 1.5: Consume streaming TTS in `mediastream-adapter.emitSideEffects`

**Files:**
- Modify: `packages/api/src/telephony/media-streams/mediastream-adapter.ts`

- [ ] **Step 1: Locate the existing `emitSideEffects` method**

Open `packages/api/src/telephony/media-streams/mediastream-adapter.ts` and find `emitSideEffects` (currently around line 534). The current loop calls `ttsProvider.synthesize(...)` and passes the full buffer to `streamPcmAsMedia`.

- [ ] **Step 2: Replace the per-effect TTS body with streaming-first logic**

Replace the body of the `for (const fx of sideEffects)` loop (everything between `for (const fx of sideEffects) {` and its closing `}` — roughly lines 537-563) with:

```typescript
for (const fx of sideEffects) {
  if (fx.type !== 'tts_play') continue;
  const text = typeof fx.payload.text === 'string' ? fx.payload.text : '';
  if (!text) continue;
  const turnId = ++this.state.outboundTurnId;
  this.state.agentSpeaking = true;
  const controller = new AbortController();
  try {
    if (typeof ttsProvider.synthesizeStream === 'function') {
      const stream = ttsProvider.synthesizeStream({
        text,
        tenantId: this.state.tenantId ?? undefined,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (turnId !== this.state.outboundTurnId || !this.state.agentSpeaking) {
          controller.abort();
          break;
        }
        if (chunk.pcm.length > 0) {
          await this.streamPcmAsMedia(chunk.pcm, turnId);
        }
        if (chunk.isFinal) break;
      }
    } else {
      const result = await ttsProvider.synthesize({
        text,
        tenantId: this.state.tenantId ?? undefined,
      });
      if (turnId !== this.state.outboundTurnId || !this.state.agentSpeaking) {
        continue;
      }
      await this.streamPcmAsMedia(result.audio, turnId);
    }
  } catch (err) {
    logger.warn('mediastream: TTS synthesize failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (turnId === this.state.outboundTurnId) {
      this.state.agentSpeaking = false;
    }
  }
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Run mediastream-adapter tests**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/telephony/media-streams/mediastream-adapter.test.ts
```

Expected: all existing tests still pass (the buffered path is unchanged for providers that lack `synthesizeStream`).

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/telephony/media-streams/mediastream-adapter.ts
git commit -m "feat(voice): prefer streaming TTS in mediastream-adapter when available"
```

---

### Task 1.6: Add integration test proving streaming path emits frames before TTS completes

**Files:**
- Modify: `packages/api/test/telephony/media-streams/mediastream-adapter.test.ts`

- [ ] **Step 1: Add a streaming TTS test case**

Append the following test inside the existing top-level `describe` block in `packages/api/test/telephony/media-streams/mediastream-adapter.test.ts`:

```typescript
it('streams outbound media as TTS chunks arrive (does not wait for full audio)', async () => {
  // Drive a fake streaming TTS provider that yields two chunks then closes.
  let firstChunkEmitted = false;
  const streamingProvider = {
    synthesize: vi.fn(),
    synthesizeStream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { pcm: Buffer.alloc(640), isFinal: false };
        firstChunkEmitted = true;
        // Simulate ~50ms of "model thinking" between chunks.
        await new Promise((r) => setTimeout(r, 50));
        yield { pcm: Buffer.alloc(640), isFinal: true };
      },
    })),
  };

  const { adapter, ws } = setupAdapter({ ttsProvider: streamingProvider });
  ws.inboundJson({ event: 'start', streamSid: 's1', start: { callSid: 'c1', accountSid: 'a1', streamSid: 's1', tracks: ['inbound'] } });
  await flushMicrotasks();

  // Directly invoke a tts_play side effect (bypass FSM for unit isolation).
  await (adapter as unknown as { emitSideEffects: (fx: unknown[]) => Promise<void> }).emitSideEffects([
    { type: 'tts_play', payload: { text: 'hello world' } },
  ]);

  expect(firstChunkEmitted).toBe(true);
  expect(streamingProvider.synthesizeStream).toHaveBeenCalledTimes(1);
  expect(ws.sent.filter((f: unknown) => (f as { event?: string }).event === 'media').length).toBeGreaterThanOrEqual(1);
});
```

If `setupAdapter` and `flushMicrotasks` helpers don't already exist in the test file, copy or define them based on the patterns already in the file (see existing `FakeWs` + `makeTtsProvider` setup near the top of the file).

- [ ] **Step 2: Run the test**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/telephony/media-streams/mediastream-adapter.test.ts -t "streams outbound media"
```

Expected: PASS.

- [ ] **Step 3: Run the full media-streams test file**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/telephony/media-streams/mediastream-adapter.test.ts
```

Expected: all pass (no regressions in the buffered path).

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/test/telephony/media-streams/mediastream-adapter.test.ts
git commit -m "test(voice): verify streaming TTS emits frames before completion"
```

---

## Section 2 — P2-2: Deepgram Keyword Boost + Endpointing Tuning

### Task 2.1: Add `sttKeywords` field to `VerticalPack` interface

**Files:**
- Modify: `packages/api/src/verticals/registry.ts`

- [ ] **Step 1: Extend the interface**

In `packages/api/src/verticals/registry.ts`, find the `VerticalPack` interface (around line 71) and add a new optional field:

```typescript
export interface VerticalPack extends CanonicalVerticalPack {
  type: VerticalType;
  name: string;
  isActive: boolean;
  categories: ServiceCategory[];
  terminology: TerminologyMap;
  intakeQuestions?: IntakeQuestionList;
  objectionScripts?: ObjectionScriptList;
  /**
   * Tokens to boost in the Deepgram streaming STT URL via the
   * `keywords` query parameter. Each entry is `term:weight` where
   * weight is 1-10. Boosting raises Deepgram's prior probability for
   * the term so HVAC/plumbing jargon does not get mis-transcribed
   * or clipped at endpoint detection.
   *
   * Example: ['furnace:3', 'compressor:3', 'condenser:3'].
   */
  sttKeywords?: ReadonlyArray<string>;
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors (optional field is non-breaking).

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/verticals/registry.ts
git commit -m "feat(verticals): add optional sttKeywords field for Deepgram boost"
```

---

### Task 2.2: Populate `sttKeywords` on HVAC, plumbing, electrical packs

**Files:**
- Modify: `packages/api/src/verticals/packs/hvac.ts`
- Modify: `packages/api/src/verticals/packs/plumbing.ts`
- Modify: `packages/api/src/verticals/packs/electrical.ts`

- [ ] **Step 1: Add HVAC keywords**

In `packages/api/src/verticals/packs/hvac.ts`, find the exported pack object and add the field. The exact location depends on how the pack is constructed (likely an object literal or builder). Add:

```typescript
sttKeywords: [
  'furnace:3',
  'compressor:3',
  'condenser:3',
  'thermostat:3',
  'heat pump:3',
  'mini split:3',
  'ductless:3',
  'evaporator:3',
  'blower motor:3',
  'refrigerant:3',
  'capacitor:3',
  'condensate:3',
],
```

- [ ] **Step 2: Add plumbing keywords**

In `packages/api/src/verticals/packs/plumbing.ts`, similarly add:

```typescript
sttKeywords: [
  'P-trap:3',
  'flange:3',
  'sump pump:3',
  'water heater:3',
  'tankless:3',
  'sewer line:3',
  'drain field:3',
  'septic:3',
  'shut-off valve:3',
  'pressure regulator:3',
  'snaking:3',
  'rooter:3',
],
```

- [ ] **Step 3: Add electrical keywords**

In `packages/api/src/verticals/packs/electrical.ts`, similarly add:

```typescript
sttKeywords: [
  'breaker:3',
  'panel:3',
  'GFCI:3',
  'sub-panel:3',
  'amperage:3',
  'voltage:3',
  'arc fault:3',
  'romex:3',
  'conduit:3',
  'service entrance:3',
],
```

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Run any existing pack tests**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/verticals
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/verticals/packs/
git commit -m "feat(verticals): add Deepgram sttKeywords to hvac/plumbing/electrical packs"
```

---

### Task 2.3: Write failing test for `VerticalTerminologyProvider`

**Files:**
- Create: `packages/api/test/voice/vertical-terminology-provider.test.ts`

- [ ] **Step 1: Create the test file**

Create `packages/api/test/voice/vertical-terminology-provider.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { VerticalTerminologyProvider } from '../../src/voice/vertical-terminology-provider';

describe('VerticalTerminologyProvider', () => {
  it('returns the active pack sttKeywords for a tenant', async () => {
    const repo = {
      findByType: vi.fn(async () => ({
        sttKeywords: ['furnace:3', 'compressor:3'],
      })),
    };
    const tenantVerticalLookup = vi.fn(async () => 'hvac' as const);
    const provider = new VerticalTerminologyProvider({
      repo: repo as never,
      lookupVertical: tenantVerticalLookup,
    });
    const keywords = await provider.getKeywords('tenant-1');
    expect(keywords).toEqual(['furnace:3', 'compressor:3']);
  });

  it('returns empty array when the tenant has no resolved vertical', async () => {
    const repo = { findByType: vi.fn(async () => null) };
    const provider = new VerticalTerminologyProvider({
      repo: repo as never,
      lookupVertical: async () => null,
    });
    expect(await provider.getKeywords('tenant-2')).toEqual([]);
  });

  it('returns empty array when the pack lacks sttKeywords', async () => {
    const repo = { findByType: vi.fn(async () => ({ /* no sttKeywords */ })) };
    const provider = new VerticalTerminologyProvider({
      repo: repo as never,
      lookupVertical: async () => 'plumbing' as const,
    });
    expect(await provider.getKeywords('tenant-3')).toEqual([]);
  });

  it('caps total returned keywords at 50 to protect Deepgram URL length', async () => {
    const many = Array.from({ length: 80 }, (_, i) => `term${i}:2`);
    const repo = { findByType: vi.fn(async () => ({ sttKeywords: many })) };
    const provider = new VerticalTerminologyProvider({
      repo: repo as never,
      lookupVertical: async () => 'hvac' as const,
    });
    const keywords = await provider.getKeywords('tenant-4');
    expect(keywords.length).toBe(50);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/voice/vertical-terminology-provider.test.ts
```

Expected: FAIL with "Cannot find module '../../src/voice/vertical-terminology-provider'".

---

### Task 2.4: Implement `VerticalTerminologyProvider`

**Files:**
- Create: `packages/api/src/voice/vertical-terminology-provider.ts`

- [ ] **Step 1: Create the implementation**

Create `packages/api/src/voice/vertical-terminology-provider.ts`:

```typescript
import type { VerticalPack, VerticalType } from '../verticals/registry';

export interface VerticalTerminologyProviderDeps {
  repo: { findByType(type: VerticalType): Promise<VerticalPack | null> };
  lookupVertical: (tenantId: string) => Promise<VerticalType | null>;
}

/**
 * Returns Deepgram keyword-boost tokens for the tenant's active vertical
 * pack. Tokens are passed straight to the Deepgram streaming URL as
 * `keywords=term1:weight,term2:weight,...`. Empty result is valid — the
 * caller omits the parameter entirely in that case.
 *
 * The 50-token cap protects Deepgram URL length and avoids degrading
 * baseline transcription quality from over-boosting.
 */
export class VerticalTerminologyProvider {
  private static readonly MAX_KEYWORDS = 50;

  constructor(private readonly deps: VerticalTerminologyProviderDeps) {}

  async getKeywords(tenantId: string): Promise<ReadonlyArray<string>> {
    const vertical = await this.deps.lookupVertical(tenantId);
    if (!vertical) return [];
    const pack = await this.deps.repo.findByType(vertical);
    const keywords = pack?.sttKeywords ?? [];
    if (keywords.length <= VerticalTerminologyProvider.MAX_KEYWORDS) {
      return keywords;
    }
    return keywords.slice(0, VerticalTerminologyProvider.MAX_KEYWORDS);
  }
}
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/voice/vertical-terminology-provider.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/voice/vertical-terminology-provider.ts packages/api/test/voice/vertical-terminology-provider.test.ts
git commit -m "feat(voice): add VerticalTerminologyProvider for Deepgram keyword boost"
```

---

### Task 2.5: Allow `DeepgramStreamingProvider` to accept keywords + endpointing override

**Files:**
- Modify: `packages/api/src/voice/transcription-providers.ts`

- [ ] **Step 1: Extend the WS URL builder**

In `packages/api/src/voice/transcription-providers.ts`, find the existing `buildWsUrl` method on `DeepgramStreamingProvider` (lines 271-277). Replace with:

```typescript
/** Build the Deepgram WS URL for a given language. Exposed for testing. */
private buildWsUrl(
  language: 'en' | 'es',
  options: { keywords?: ReadonlyArray<string>; endpointingMs?: number } = {}
): string {
  const endpointing = options.endpointingMs ?? 600;
  let url =
    'wss://api.deepgram.com/v1/listen' +
    `?model=nova-3&language=${language}&encoding=linear16&sample_rate=16000` +
    `&channels=1&interim_results=true&smart_format=true&endpointing=${endpointing}`;
  if (options.keywords && options.keywords.length > 0) {
    const enc = options.keywords.map((k) => encodeURIComponent(k)).join(',');
    url += `&keywords=${enc}`;
  }
  return url;
}
```

- [ ] **Step 2: Extend `openSession` to accept and forward the options**

In the same class, replace the existing `openSession(...)` method (lines 279-337) with:

```typescript
async openSession(
  onEvent: StreamingTranscriptCallback,
  onError: (err: Error) => void,
  onClose: () => void,
  language?: 'en' | 'es',
  options: { keywords?: ReadonlyArray<string>; endpointingMs?: number } = {}
): Promise<StreamingSession> {
  const lang = language ?? this.defaultLanguage;
  const url = `${this.buildWsUrl(lang, options)}&token=${this.apiKey}`;
  const ws = new WebSocket(url);
  // ... rest of the function body stays exactly as before (event listeners + return) ...
```

When making the edit, copy lines 290-337 verbatim after the new `const ws = ...` line. The only changes are: the new `options` parameter, the new `const url = ...` line, and the call to `buildWsUrl(lang, options)`.

- [ ] **Step 3: Update the `StreamingTranscriptionProvider` interface**

In the same file, replace the existing interface (around lines 237-245) with:

```typescript
export interface StreamingTranscriptionProvider {
  openSession(
    onEvent: StreamingTranscriptCallback,
    onError: (err: Error) => void,
    onClose: () => void,
    language?: 'en' | 'es',
    options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }
  ): Promise<StreamingSession>;
}
```

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/voice/transcription-providers.ts
git commit -m "feat(voice): Deepgram WS URL accepts keyword boost + endpointing override"
```

---

### Task 2.6: Add URL builder tests for keyword boost + endpointing

**Files:**
- Modify or create: `packages/api/test/voice/transcription-providers.test.ts`

- [ ] **Step 1: Check whether a test file exists**

```bash
ls /Users/macmini/Serviceos/Serviceos/packages/api/test/voice/transcription-providers.test.ts 2>/dev/null || echo "missing"
```

If "missing", create the file. Otherwise, append the new `describe` block below to the existing file.

- [ ] **Step 2: Add the tests**

Add the following (as a new file or new `describe` block):

```typescript
import { describe, it, expect } from 'vitest';
import { DeepgramStreamingProvider } from '../../src/voice/transcription-providers';

describe('DeepgramStreamingProvider URL builder', () => {
  const provider = new DeepgramStreamingProvider('test-key');

  it('uses default 600ms endpointing when no override is supplied', () => {
    const url = (provider as unknown as {
      buildWsUrl: (lang: 'en' | 'es', options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }) => string;
    }).buildWsUrl('en');
    expect(url).toContain('endpointing=600');
  });

  it('honors a custom endpointing override', () => {
    const url = (provider as unknown as {
      buildWsUrl: (lang: 'en' | 'es', options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }) => string;
    }).buildWsUrl('en', { endpointingMs: 450 });
    expect(url).toContain('endpointing=450');
  });

  it('appends URL-encoded keywords when provided', () => {
    const url = (provider as unknown as {
      buildWsUrl: (lang: 'en' | 'es', options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }) => string;
    }).buildWsUrl('en', { keywords: ['heat pump:3', 'P-trap:3'] });
    expect(url).toContain('keywords=heat%20pump%3A3,P-trap%3A3');
  });

  it('omits the keywords parameter when the list is empty', () => {
    const url = (provider as unknown as {
      buildWsUrl: (lang: 'en' | 'es', options?: { keywords?: ReadonlyArray<string>; endpointingMs?: number }) => string;
    }).buildWsUrl('en', { keywords: [] });
    expect(url).not.toContain('keywords=');
  });
});
```

- [ ] **Step 3: Run the test**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/voice/transcription-providers.test.ts
```

Expected: all 4 pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/test/voice/transcription-providers.test.ts
git commit -m "test(voice): cover Deepgram URL builder keyword boost + endpointing"
```

---

### Task 2.7: Wire `VerticalTerminologyProvider` into the media-stream adapter's Deepgram open call

**Files:**
- Modify: `packages/api/src/telephony/media-streams/mediastream-adapter.ts`

- [ ] **Step 1: Extend `MediaStreamAdapterDeps` with the terminology provider**

In `packages/api/src/telephony/media-streams/mediastream-adapter.ts`, find the `MediaStreamAdapterDeps` interface (around line 116). Add an optional field:

```typescript
/**
 * Resolves Deepgram keyword-boost tokens for the tenant. Optional —
 * when omitted, Deepgram opens without keyword boost.
 */
terminologyProvider?: {
  getKeywords(tenantId: string): Promise<ReadonlyArray<string>>;
};
```

- [ ] **Step 2: Use the provider when opening the Deepgram session**

Find `handleStart` (around line 348). Locate the existing `this.deps.streamingProvider.openSession(...)` call (around line 398). Just before that call, add:

```typescript
const keywords = this.deps.terminologyProvider
  ? await this.deps.terminologyProvider.getKeywords(session.tenantId).catch(() => [])
  : [];
```

Then change the `openSession` call to pass the keywords:

```typescript
this.state.deepgram = await this.deps.streamingProvider.openSession(
  (event) => {
    this.onTranscriptEvent(event).catch((err) => {
      logger.warn('mediastream transcript handler threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  },
  (err) => {
    logger.warn('mediastream deepgram error', { error: err.message });
  },
  () => {
    // Deepgram closed independently — we can still drain Twilio
    // until it sends `stop`. No-op.
  },
  undefined, // language defaults
  keywords.length > 0 ? { keywords } : undefined
);
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Run mediastream-adapter tests**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/telephony/media-streams/mediastream-adapter.test.ts
```

Expected: all pass (terminologyProvider is optional; existing tests do not pass one).

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/telephony/media-streams/mediastream-adapter.ts
git commit -m "feat(voice): pass tenant vertical keywords to Deepgram on stream open"
```

---

### Task 2.8: Wire the provider through application bootstrap

**Files:**
- Modify: `packages/api/src/app.ts` (or wherever the adapter deps are assembled — confirm via grep)

- [ ] **Step 1: Locate the deps assembly site**

```bash
grep -rn "MediaStreamAdapterDeps\|TwilioMediaStreamAdapter\|streamingProvider:" /Users/macmini/Serviceos/Serviceos/packages/api/src --include="*.ts" | head -20
```

The dep wiring is most likely in `packages/api/src/app.ts` or `packages/api/src/telephony/media-streams/twilio-mediastream-server.ts`. Read the file and find where `streamingProvider` is set.

- [ ] **Step 2: Add `terminologyProvider` to the wiring**

In that file, add:

```typescript
import { VerticalTerminologyProvider } from './voice/vertical-terminology-provider';
// ... in the assembly block where streamingProvider is constructed:
const terminologyProvider = new VerticalTerminologyProvider({
  repo: verticalPackRepository, // existing repo instance — locate the name in the file
  lookupVertical: async (tenantId: string) => {
    // Use whatever existing function resolves a tenant's active vertical.
    // Likely `resolveActiveVertical(tenantId)` or a settings lookup.
    return resolveActiveVerticalForTenant(tenantId);
  },
});
```

Then pass it into the `MediaStreamAdapterDeps`:

```typescript
{
  store,
  streamingProvider,
  ttsProvider,
  speechTurn,
  initializeSession,
  terminologyProvider, // NEW
}
```

If `resolveActiveVerticalForTenant` does not exist, add a TODO comment and grep for the canonical lookup; substitute with whatever exists. (This may surface during step 3 typecheck.)

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors. If the vertical-lookup function name is wrong, the typecheck will tell you exactly what to use — fix and re-run.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/app.ts # or whatever file you edited
git commit -m "feat(voice): wire VerticalTerminologyProvider into mediastream adapter bootstrap"
```

---

## Section 3 — P2-4: Greeting Soft Prompt Cue

### Task 3.1: Ensure `buildTelephonyGreeting` always ends with a conversational prompt

**Files:**
- Modify: `packages/api/src/telephony/twilio-adapter.ts`

- [ ] **Step 1: Locate `buildTelephonyGreeting`**

Open `packages/api/src/telephony/twilio-adapter.ts` and find `buildTelephonyGreeting` (referenced in handleStart greeting flow, exact line ~590).

- [ ] **Step 2: Adjust the function to always end with a prompt cue**

The current fallback greeting reads `"Thank you for calling ${businessName}. How can I help you today?"`. The persona variant reads `"${persona.greeting} ${disclosureText}"`. Ensure both code paths terminate with a question. Specifically, replace the function body so it returns:

- If the constructed greeting already ends with `?`, return as-is.
- Otherwise, append `' What can I help you with today?'` (with leading space).

Pseudocode (adapt to the actual function signature):

```typescript
const greeting = /* existing construction */;
const trimmed = greeting.trim();
return trimmed.endsWith('?') ? trimmed : `${trimmed} What can I help you with today?`;
```

- [ ] **Step 3: Run twilio-adapter tests**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/telephony/twilio-adapter
```

Expected: all pass — the change is additive for paths that already end with `?`.

- [ ] **Step 4: Add an explicit test for the prompt cue**

If `packages/api/test/telephony/twilio-adapter.test.ts` exists, append:

```typescript
it('buildTelephonyGreeting ends with a question prompt cue', () => {
  // Persona path: greeting that does not already end with a question.
  const result = buildTelephonyGreeting({
    businessName: 'Joes HVAC',
    persona: { greeting: 'Hi, this is Sarah.', agentName: 'Sarah' },
    disclosureText: 'This call may be recorded for quality.',
  });
  expect(result.trim().endsWith('?')).toBe(true);
});

it('buildTelephonyGreeting does not double up a prompt when one is already present', () => {
  const result = buildTelephonyGreeting({
    businessName: 'Joes HVAC',
    persona: { greeting: 'Hi, this is Sarah. What can I help you with today?', agentName: 'Sarah' },
    disclosureText: '',
  });
  // Only one question mark in the result.
  expect((result.match(/\?/g) ?? []).length).toBe(1);
});
```

Adjust the import + argument names to match the real function signature.

- [ ] **Step 5: Run the new test**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/telephony/twilio-adapter.test.ts -t "prompt cue"
```

Expected: both new tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/telephony/twilio-adapter.ts packages/api/test/telephony/twilio-adapter.test.ts
git commit -m "feat(voice): greeting always ends with conversational prompt cue"
```

---

## Section 4 — P2-3: Conversational Repair Templates

### Task 4.1: Add `repairTemplates` to vertical pack types

**Files:**
- Modify: `packages/api/src/verticals/registry.ts`

- [ ] **Step 1: Extend `VerticalPack` with `repairTemplates`**

In `packages/api/src/verticals/registry.ts`, extend the interface added in Task 2.1:

```typescript
export interface RepairTemplate {
  /** When the FSM low-confidence signal matches this trigger, pick this template. */
  trigger: 'low_intent_confidence' | 'low_audio_confidence' | 'ambiguous_service_type' | 'ambiguous_entity';
  /** TTS text spoken to the caller. Use plain English; no SSML for now. */
  text: string;
}

export interface VerticalPack extends CanonicalVerticalPack {
  // ... existing fields ...
  sttKeywords?: ReadonlyArray<string>;
  repairTemplates?: ReadonlyArray<RepairTemplate>;
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/verticals/registry.ts
git commit -m "feat(verticals): add RepairTemplate type + optional pack field"
```

---

### Task 4.2: Populate `repairTemplates` on each pack

**Files:**
- Modify: `packages/api/src/verticals/packs/hvac.ts`
- Modify: `packages/api/src/verticals/packs/plumbing.ts`
- Modify: `packages/api/src/verticals/packs/electrical.ts`

- [ ] **Step 1: HVAC**

In `packages/api/src/verticals/packs/hvac.ts`, add:

```typescript
repairTemplates: [
  { trigger: 'ambiguous_service_type', text: 'Is this for your heating or your cooling?' },
  { trigger: 'low_intent_confidence', text: 'Is this about scheduling a visit, or is something not working right now?' },
  { trigger: 'low_audio_confidence', text: "I'm having trouble hearing you — could you say that one more time?" },
  { trigger: 'ambiguous_entity', text: 'Just to make sure I have the right name — could you spell that for me?' },
],
```

- [ ] **Step 2: Plumbing**

In `packages/api/src/verticals/packs/plumbing.ts`, add:

```typescript
repairTemplates: [
  { trigger: 'ambiguous_service_type', text: 'Is this an emergency, like flooding or a burst pipe, or can we schedule a visit?' },
  { trigger: 'low_intent_confidence', text: 'Are you reporting a problem with water, drains, or your water heater?' },
  { trigger: 'low_audio_confidence', text: "I'm having trouble hearing you — could you say that one more time?" },
  { trigger: 'ambiguous_entity', text: 'Just to make sure I have the right name — could you spell that for me?' },
],
```

- [ ] **Step 3: Electrical**

In `packages/api/src/verticals/packs/electrical.ts`, add:

```typescript
repairTemplates: [
  { trigger: 'ambiguous_service_type', text: 'Is this about a power outage, or about installing or fixing wiring?' },
  { trigger: 'low_intent_confidence', text: 'Are you reporting a loss of power, or something else electrical?' },
  { trigger: 'low_audio_confidence', text: "I'm having trouble hearing you — could you say that one more time?" },
  { trigger: 'ambiguous_entity', text: 'Just to make sure I have the right name — could you spell that for me?' },
],
```

- [ ] **Step 4: Run typecheck + vertical tests**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run test/verticals
```

Expected: zero errors; all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/verticals/packs/
git commit -m "feat(verticals): add vertical-specific repair templates to packs"
```

---

### Task 4.3: Write failing test for `selectRepairTemplate`

**Files:**
- Create: `packages/api/test/ai/agents/customer-calling/repair-templates.test.ts`

- [ ] **Step 1: Create the test**

```typescript
import { describe, it, expect } from 'vitest';
import { selectRepairTemplate } from '../../../../src/ai/agents/customer-calling/repair-templates';
import type { RepairTemplate } from '../../../../src/verticals/registry';

const templates: RepairTemplate[] = [
  { trigger: 'ambiguous_service_type', text: 'Heating or cooling?' },
  { trigger: 'low_intent_confidence', text: 'Scheduling or emergency?' },
  { trigger: 'low_audio_confidence', text: 'Could you repeat that?' },
];

describe('selectRepairTemplate', () => {
  it('picks the matching template by trigger', () => {
    const t = selectRepairTemplate(templates, { trigger: 'low_intent_confidence' });
    expect(t?.text).toBe('Scheduling or emergency?');
  });

  it('falls back to low_intent_confidence when the requested trigger is missing', () => {
    const reduced = templates.filter((x) => x.trigger !== 'ambiguous_entity');
    const t = selectRepairTemplate(reduced, { trigger: 'ambiguous_entity' });
    expect(t?.text).toBe('Scheduling or emergency?');
  });

  it('returns undefined when no templates are present at all', () => {
    expect(selectRepairTemplate([], { trigger: 'low_audio_confidence' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/ai/agents/customer-calling/repair-templates.test.ts
```

Expected: FAIL with "Cannot find module".

---

### Task 4.4: Implement `selectRepairTemplate`

**Files:**
- Create: `packages/api/src/ai/agents/customer-calling/repair-templates.ts`

- [ ] **Step 1: Create the implementation**

```typescript
import type { RepairTemplate } from '../../../verticals/registry';

export interface RepairContext {
  trigger: RepairTemplate['trigger'];
}

/**
 * Pick a repair template for the FSM to speak. Returns the first
 * template that matches the requested trigger, or falls back to the
 * `low_intent_confidence` template if the exact trigger has no entry
 * (intent-level reprompt is the safest default).
 *
 * Returns undefined only when the vertical pack supplied no templates
 * at all — caller is expected to fall back to the existing generic
 * reprompt in that case.
 */
export function selectRepairTemplate(
  templates: ReadonlyArray<RepairTemplate>,
  ctx: RepairContext
): RepairTemplate | undefined {
  if (templates.length === 0) return undefined;
  const exact = templates.find((t) => t.trigger === ctx.trigger);
  if (exact) return exact;
  return templates.find((t) => t.trigger === 'low_intent_confidence');
}
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/ai/agents/customer-calling/repair-templates.test.ts
```

Expected: all 3 pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/agents/customer-calling/repair-templates.ts packages/api/test/ai/agents/customer-calling/repair-templates.test.ts
git commit -m "feat(calling): add selectRepairTemplate helper for vertical-aware reprompts"
```

---

### Task 4.5: Use repair templates in the FSM `intent_capture` low-confidence path

**Files:**
- Modify: `packages/api/src/ai/agents/customer-calling/transitions.ts`

- [ ] **Step 1: Locate the existing low-confidence handler**

Find the `intent_capture` state handler (around lines 370-440 per the reference). The existing path emits `ttsPlay("I want to make sure I got that right — can you say that again?")` when confidence < `TAU_INT`.

- [ ] **Step 2: Thread repair templates into the context**

The FSM context (`CallingAgentContext`) needs access to the active vertical's repair templates. Extend the context type in `types.ts` with an optional field:

```typescript
// In packages/api/src/ai/agents/customer-calling/types.ts, inside CallingAgentContext:
repairTemplates?: ReadonlyArray<RepairTemplate>;
```

Add the import at the top of that file:

```typescript
import type { RepairTemplate } from '../../../verticals/registry';
```

- [ ] **Step 3: Use `selectRepairTemplate` in the reprompt path**

In `packages/api/src/ai/agents/customer-calling/transitions.ts`, add the import at the top:

```typescript
import { selectRepairTemplate } from './repair-templates';
```

Find the low-confidence reprompt site (the `ttsPlay("I want to make sure...")` call). Replace with:

```typescript
const repair = selectRepairTemplate(context.repairTemplates ?? [], {
  trigger: 'low_intent_confidence',
});
const repromptText = repair?.text ?? 'I want to make sure I got that right — can you say that again?';
const sideEffects = [ttsPlay(repromptText)];
```

If there is a separate site for `low_audio_confidence` (low STT confidence rather than low intent confidence), apply the same pattern with `trigger: 'low_audio_confidence'`. Search the file for any other generic "say that again" strings and route them through `selectRepairTemplate` similarly.

- [ ] **Step 4: Wire `repairTemplates` into the context at FSM construction**

The FSM is constructed somewhere in `twilio-adapter.ts` (call setup) or `inapp-adapter.ts`. Search for `new CallingAgentStateMachine(` and add a `repairTemplates` field to the context literal, pulling from the resolved vertical pack:

```bash
grep -rn "new CallingAgentStateMachine(" /Users/macmini/Serviceos/Serviceos/packages/api/src --include="*.ts"
```

For each construction site, fetch the pack (it should already be available because vertical resolution happens earlier in the call flow) and pass `pack?.repairTemplates`.

- [ ] **Step 5: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/agents/customer-calling/
git commit -m "feat(calling): use vertical repair templates on low-confidence reprompts"
```

---

### Task 4.6: Add FSM test for vertical-aware reprompt

**Files:**
- Modify or create: `packages/api/test/ai/agents/customer-calling/transitions.test.ts`

- [ ] **Step 1: Check if a transitions test file exists**

```bash
ls /Users/macmini/Serviceos/Serviceos/packages/api/test/ai/agents/customer-calling/transitions.test.ts 2>/dev/null || echo "missing"
```

- [ ] **Step 2: Add (or create) a test for the HVAC repair flow**

```typescript
import { describe, it, expect } from 'vitest';
import { transition } from '../../../../src/ai/agents/customer-calling/transitions';
import type { CallingAgentContext } from '../../../../src/ai/agents/customer-calling/types';

const baseContext: CallingAgentContext = {
  // Fill in the minimal valid fields based on the existing context type.
  // Most fields will be defaults; the important ones for this test are
  // the FSM-tracked counters and the repair templates.
  retryCount: 0,
  repromptCount: 0,
  startedAt: Date.now(),
  repairTemplates: [
    { trigger: 'low_intent_confidence', text: 'Is this about scheduling a visit, or is something not working right now?' },
  ],
  // ... add any other required fields exactly as defined in types.ts ...
} as CallingAgentContext;

describe('intent_capture low-confidence reprompt', () => {
  it('uses the vertical low_intent_confidence template when present', () => {
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'unknown', entities: {}, confidence: 0.4 },
      baseContext
    );
    const ttsText = result.sideEffects
      .filter((fx) => fx.type === 'tts_play')
      .map((fx) => (fx.payload as { text: string }).text)
      .join('');
    expect(ttsText).toContain('scheduling a visit');
  });

  it('falls back to the generic reprompt when no templates are supplied', () => {
    const ctx = { ...baseContext, repairTemplates: undefined };
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'unknown', entities: {}, confidence: 0.4 },
      ctx
    );
    const ttsText = result.sideEffects
      .filter((fx) => fx.type === 'tts_play')
      .map((fx) => (fx.payload as { text: string }).text)
      .join('');
    expect(ttsText).toContain('say that again');
  });
});
```

Adjust `baseContext` to satisfy whatever `CallingAgentContext` requires — read `types.ts` and supply the minimum needed fields.

- [ ] **Step 3: Run the test**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/ai/agents/customer-calling/transitions.test.ts
```

Expected: both new tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/test/ai/agents/customer-calling/transitions.test.ts
git commit -m "test(calling): verify vertical repair templates drive low-confidence reprompt"
```

---

## Section 5 — P2-1: Backchannel / Filler Engine

### Task 5.1: Add `filler_fired` and `filler_cancelled` voice quality events

**Files:**
- Modify: `packages/api/src/ai/voice-quality/events.ts`

- [ ] **Step 1: Append the new event constructors and types**

Read the existing `VoiceSessionEvent` discriminated union and append two new variants. Add at the bottom of `events.ts`:

```typescript
export interface FillerFiredEvent {
  type: 'filler_fired';
  fillerText: string;
  ts: number;
}

export interface FillerCancelledEvent {
  type: 'filler_cancelled';
  fillerText: string;
  ts: number;
}

export interface RepairTemplateFiredEvent {
  type: 'repair_template_fired';
  trigger: string;
  text: string;
  ts: number;
}

export const fillerFiredEvent = (opts: { fillerText: string; ts?: number }): FillerFiredEvent => ({
  type: 'filler_fired',
  fillerText: opts.fillerText,
  ts: opts.ts ?? Date.now(),
});

export const fillerCancelledEvent = (opts: { fillerText: string; ts?: number }): FillerCancelledEvent => ({
  type: 'filler_cancelled',
  fillerText: opts.fillerText,
  ts: opts.ts ?? Date.now(),
});

export const repairTemplateFiredEvent = (opts: {
  trigger: string;
  text: string;
  ts?: number;
}): RepairTemplateFiredEvent => ({
  type: 'repair_template_fired',
  trigger: opts.trigger,
  text: opts.text,
  ts: opts.ts ?? Date.now(),
});
```

- [ ] **Step 2: Add the new variants to the union type**

In the same file, find the existing `VoiceSessionEvent` union (likely a discriminated `type | type | type` declaration) and append `| FillerFiredEvent | FillerCancelledEvent | RepairTemplateFiredEvent`.

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/voice-quality/events.ts
git commit -m "feat(voice-quality): add filler/repair telemetry events"
```

---

### Task 5.2: Emit `repair_template_fired` from the FSM repair path

**Files:**
- Modify: `packages/api/src/ai/agents/customer-calling/transitions.ts`

- [ ] **Step 1: Wire telemetry emission**

The FSM cannot directly emit on the voice-quality event bus (it is a pure reducer). Instead, add a side-effect type variant. In `types.ts`:

```typescript
// Add to SideEffectType union:
export type SideEffectType =
  | 'tts_play'
  | 'audit_log'
  | 'create_proposal'
  | 'notify_oncall'
  | 'start_transcription'
  | 'end_session'
  | 'emit_quality_event';
```

- [ ] **Step 2: Emit the event from the repair path**

In the same `intent_capture` low-confidence branch you modified in Task 4.5, append a second side effect:

```typescript
const sideEffects: SideEffect[] = [
  ttsPlay(repromptText),
  {
    type: 'emit_quality_event',
    payload: {
      eventType: 'repair_template_fired',
      trigger: 'low_intent_confidence',
      text: repromptText,
    },
  },
];
```

- [ ] **Step 3: Wire the side-effect handler in `mediastream-adapter.emitSideEffects`**

In `mediastream-adapter.ts`, extend the side-effect loop to handle `emit_quality_event`. Just before the existing `if (fx.type !== 'tts_play') continue;` short-circuit, add:

```typescript
if (fx.type === 'emit_quality_event' && this.state.session) {
  const eventType = String((fx.payload as { eventType?: string }).eventType ?? '');
  if (eventType === 'repair_template_fired') {
    this.state.session.events.emit(VOICE_EVENT_CHANNEL, repairTemplateFiredEvent({
      trigger: String((fx.payload as { trigger?: string }).trigger ?? ''),
      text: String((fx.payload as { text?: string }).text ?? ''),
    }));
  }
  continue;
}
```

Add the import:

```typescript
import { repairTemplateFiredEvent } from '../../ai/voice-quality/events';
```

Also wire this in the `inapp-adapter` (search for its `emitSideEffects` equivalent — it likely renders side effects similarly).

- [ ] **Step 4: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/agents/customer-calling/ packages/api/src/telephony/media-streams/mediastream-adapter.ts
git commit -m "feat(voice-quality): emit repair_template_fired telemetry from FSM"
```

---

### Task 5.3: Create the filler library directory + manifest

**Files:**
- Create: `packages/api/src/ai/agents/customer-calling/fillers/manifest.ts`

- [ ] **Step 1: Define the canonical filler list**

```typescript
/**
 * Canonical filler library. Each entry is pre-rendered to a PCM file
 * named `<id>.pcm` by `scripts/render-fillers.ts` at deploy time.
 *
 * Rules:
 *   - Six to ten entries — fewer feels robotic on repeat, more is overkill.
 *   - Short (~150-400ms) — fillers buy time, they don't pad it.
 *   - Tone: neutral, warm, professional. No exclamations.
 *   - Avoid words the FSM may accidentally repeat in the real response.
 */
export interface Filler {
  id: string;
  text: string;
  /** Approximate playback duration in milliseconds, set after rendering. */
  approxDurationMs: number;
}

export const FILLER_LIBRARY: ReadonlyArray<Filler> = [
  { id: 'mm-hmm', text: 'Mm-hmm.', approxDurationMs: 320 },
  { id: 'okay', text: 'Okay.', approxDurationMs: 260 },
  { id: 'got-it', text: 'Got it.', approxDurationMs: 340 },
  { id: 'one-moment', text: 'One moment.', approxDurationMs: 480 },
  { id: 'let-me-check', text: 'Let me check on that.', approxDurationMs: 720 },
  { id: 'let-me-see', text: 'Let me see.', approxDurationMs: 520 },
  { id: 'sure-thing', text: 'Sure thing.', approxDurationMs: 380 },
  { id: 'absolutely', text: 'Absolutely.', approxDurationMs: 540 },
];
```

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/agents/customer-calling/fillers/manifest.ts
git commit -m "feat(voice): add canonical filler library manifest"
```

---

### Task 5.4: Write the filler renderer script

**Files:**
- Create: `scripts/render-fillers.ts`

- [ ] **Step 1: Create the script**

```typescript
#!/usr/bin/env node
/**
 * Deploy-time script: synthesizes each filler in FILLER_LIBRARY via the
 * configured TTS provider and writes the PCM bytes to
 * packages/api/src/ai/agents/customer-calling/fillers/<id>.pcm.
 *
 * Run manually before deploys when the library or voice changes:
 *
 *   TTS_PROVIDER=elevenlabs ELEVENLABS_API_KEY=... \
 *     npx tsx scripts/render-fillers.ts
 *
 * The script is intentionally idempotent — re-running with the same
 * voice + library produces byte-identical files.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTtsProvider } from '../packages/api/src/ai/tts/tts-provider';
import { FILLER_LIBRARY } from '../packages/api/src/ai/agents/customer-calling/fillers/manifest';

async function main(): Promise<void> {
  const provider = createTtsProvider({
    TTS_PROVIDER: process.env.TTS_PROVIDER,
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
    AI_PROVIDER_API_KEY: process.env.AI_PROVIDER_API_KEY,
  });
  if (!provider) {
    throw new Error('No TTS provider configured — set TTS_PROVIDER + the matching API key.');
  }
  const outDir = resolve(
    __dirname,
    '../packages/api/src/ai/agents/customer-calling/fillers'
  );
  mkdirSync(outDir, { recursive: true });
  for (const filler of FILLER_LIBRARY) {
    const result = await provider.synthesize({ text: filler.text });
    // Provider returns container audio (mp3 from OpenAI, mp3 from ElevenLabs REST).
    // We write the raw bytes; the runtime decoder is responsible for converting
    // to PCM 16 kHz before handing to the Twilio media-stream emitter.
    const path = resolve(outDir, `${filler.id}.${result.contentType.includes('mpeg') ? 'mp3' : 'bin'}`);
    writeFileSync(path, result.audio);
    // eslint-disable-next-line no-console
    console.log(`rendered ${filler.id} → ${path} (${result.audio.length} bytes)`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add a `.gitignore` entry for generated audio**

In the repo root `.gitignore`, append:

```
packages/api/src/ai/agents/customer-calling/fillers/*.mp3
packages/api/src/ai/agents/customer-calling/fillers/*.bin
packages/api/src/ai/agents/customer-calling/fillers/*.pcm
```

(Generated assets are produced at deploy time per environment voice — not committed.)

- [ ] **Step 3: Run typecheck on the script**

```bash
cd /Users/macmini/Serviceos/Serviceos && npx tsc --noEmit scripts/render-fillers.ts
```

If that fails because there is no root tsconfig that includes scripts/, run instead:

```bash
cd /Users/macmini/Serviceos/Serviceos && npx tsx --check scripts/render-fillers.ts
```

If neither command exists, fall back to `npx tsx scripts/render-fillers.ts --dry-run` — adjust the script to early-return when given that flag. (For now, just confirm the import paths resolve by running `npx tsx scripts/render-fillers.ts` with no env, which should throw the "no TTS provider" error rather than a module-resolution error.)

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add scripts/render-fillers.ts .gitignore
git commit -m "feat(voice): add deploy-time filler renderer script"
```

---

### Task 5.5: Write failing test for `FillerEngine` selection + non-repeat rule

**Files:**
- Create: `packages/api/test/ai/agents/customer-calling/filler-engine.test.ts`

- [ ] **Step 1: Create the test**

```typescript
import { describe, it, expect } from 'vitest';
import { FillerEngine } from '../../../../src/ai/agents/customer-calling/filler-engine';
import { FILLER_LIBRARY } from '../../../../src/ai/agents/customer-calling/fillers/manifest';

describe('FillerEngine.selectNext', () => {
  it('returns one of the library entries', () => {
    const engine = new FillerEngine();
    const f = engine.selectNext();
    expect(FILLER_LIBRARY.map((x) => x.id)).toContain(f.id);
  });

  it('does not return the same filler twice in a row', () => {
    const engine = new FillerEngine();
    const first = engine.selectNext();
    const second = engine.selectNext();
    expect(second.id).not.toBe(first.id);
  });

  it('skips selection entirely when skipFillers is true', () => {
    const engine = new FillerEngine();
    const f = engine.selectNext({ skipFillers: true });
    expect(f).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/ai/agents/customer-calling/filler-engine.test.ts
```

Expected: FAIL with "Cannot find module".

---

### Task 5.6: Implement `FillerEngine`

**Files:**
- Create: `packages/api/src/ai/agents/customer-calling/filler-engine.ts`

- [ ] **Step 1: Implement**

```typescript
import { FILLER_LIBRARY, type Filler } from './fillers/manifest';

export interface FillerSelectContext {
  /** Caller opts out of fillers (e.g. emergency in progress, or post-greeting silence). */
  skipFillers?: boolean;
}

/**
 * Selection logic for the filler library. Tracks the previously-emitted
 * filler so we never repeat back-to-back. Pure — no I/O. The audio
 * playback path (loading the PCM from disk, emitting Twilio media
 * frames) lives in mediastream-adapter.
 *
 * Decoupled from CallingAgentState on purpose — emergency routing
 * lives in Layer 3 and the caller (mediastream-adapter) decides
 * whether to suppress fillers based on whatever signal it has.
 */
export class FillerEngine {
  private lastId: string | null = null;
  private cursor = 0;

  selectNext(ctx: FillerSelectContext = {}): Filler | undefined {
    if (ctx.skipFillers) return undefined;
    if (FILLER_LIBRARY.length === 0) return undefined;
    // Round-robin with skip on repeat — stable, predictable, no RNG.
    for (let i = 0; i < FILLER_LIBRARY.length; i++) {
      const candidate = FILLER_LIBRARY[(this.cursor + i) % FILLER_LIBRARY.length];
      if (candidate.id !== this.lastId) {
        this.cursor = (this.cursor + i + 1) % FILLER_LIBRARY.length;
        this.lastId = candidate.id;
        return candidate;
      }
    }
    return undefined;
  }
}
```

- [ ] **Step 2: Run the test**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/ai/agents/customer-calling/filler-engine.test.ts
```

Expected: all 3 pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/agents/customer-calling/filler-engine.ts packages/api/test/ai/agents/customer-calling/filler-engine.test.ts
git commit -m "feat(voice): add FillerEngine selection logic with no-repeat rule"
```

---

### Task 5.7: Load + cache filler audio at boot

**Files:**
- Create: `packages/api/src/ai/agents/customer-calling/filler-audio-cache.ts`

- [ ] **Step 1: Implement the cache**

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FILLER_LIBRARY } from './fillers/manifest';

/**
 * Loads pre-rendered filler audio from disk into memory at boot. The
 * audio is whatever container the TTS provider produced (mp3 from
 * OpenAI/ElevenLabs REST). The mediastream-adapter is responsible for
 * decoding to PCM 16 kHz before emission.
 *
 * Missing files do NOT throw — they are simply skipped. This lets a
 * partial render survive boot; the unrendered fillers are unavailable
 * but other fillers still play. Logs a warning so the gap is visible.
 */
export class FillerAudioCache {
  private readonly cache = new Map<string, Buffer>();

  constructor(
    private readonly rootDir: string,
    private readonly logger: { warn: (msg: string, meta?: unknown) => void } = console,
  ) {}

  load(): void {
    for (const filler of FILLER_LIBRARY) {
      // Prefer mp3 — current renderer output. Allow .bin or .pcm overrides.
      const candidates = ['mp3', 'bin', 'pcm'].map((ext) =>
        resolve(this.rootDir, `${filler.id}.${ext}`)
      );
      const path = candidates.find((p) => existsSync(p));
      if (!path) {
        this.logger.warn('filler audio missing', { id: filler.id, candidates });
        continue;
      }
      this.cache.set(filler.id, readFileSync(path));
    }
  }

  get(id: string): Buffer | undefined {
    return this.cache.get(id);
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  size(): number {
    return this.cache.size;
  }
}
```

- [ ] **Step 2: Add a basic test**

Create `packages/api/test/ai/agents/customer-calling/filler-audio-cache.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FillerAudioCache } from '../../../../src/ai/agents/customer-calling/filler-audio-cache';

describe('FillerAudioCache', () => {
  it('loads files present on disk and skips missing ones without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fillers-'));
    writeFileSync(join(dir, 'mm-hmm.mp3'), Buffer.from([1, 2, 3]));
    writeFileSync(join(dir, 'okay.mp3'), Buffer.from([4, 5, 6]));
    const warnings: unknown[] = [];
    const cache = new FillerAudioCache(dir, { warn: (m, meta) => warnings.push({ m, meta }) });
    cache.load();
    expect(cache.has('mm-hmm')).toBe(true);
    expect(cache.has('okay')).toBe(true);
    expect(cache.has('got-it')).toBe(false);
    expect(warnings.length).toBeGreaterThan(0); // got-it + others missing
  });
});
```

- [ ] **Step 3: Run typecheck + test**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run test/ai/agents/customer-calling/filler-audio-cache.test.ts
```

Expected: zero errors; test passes.

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/agents/customer-calling/filler-audio-cache.ts packages/api/test/ai/agents/customer-calling/filler-audio-cache.test.ts
git commit -m "feat(voice): cache pre-rendered filler audio at boot"
```

---

### Task 5.8: Decode filler audio to PCM helper

**Files:**
- Create: `packages/api/src/ai/agents/customer-calling/decode-filler.ts`

- [ ] **Step 1: Check for an existing audio decoder in the codebase**

```bash
grep -rn "audio-decode\|ffmpeg\|fluent-ffmpeg\|mp3-decoder\|@ffmpeg" /Users/macmini/Serviceos/Serviceos/packages/api/src --include="*.ts" | head -10
grep -rn "mpg123\|node-lame" /Users/macmini/Serviceos/Serviceos/packages/api --include="*.ts" | head -5
```

- [ ] **Step 2: Implement the decoder**

If an existing decoder is present, use it. Otherwise, the simplest path is to pre-render fillers directly as raw PCM 16 kHz from ElevenLabs (which supports `output_format=pcm_16000`). Update the renderer in Task 5.4 to request PCM directly:

In `scripts/render-fillers.ts`, replace the call to `provider.synthesize` with a direct fetch to ElevenLabs requesting `output_format=pcm_16000`. The file extension becomes `.pcm` and the cache returns raw PCM bytes — no runtime decode needed.

The decoder file becomes a no-op pass-through:

```typescript
/**
 * Filler audio is pre-rendered as raw PCM 16-bit signed little-endian
 * @ 16 kHz mono (see scripts/render-fillers.ts). The "decoder" is
 * therefore just a type-tightening pass-through — no actual decoding
 * happens at runtime, which keeps the hot path allocation-free.
 *
 * If the renderer is changed to emit a container format (mp3, wav),
 * this is the single hook to add real decoding.
 */
export function decodeFillerToPcm16k(raw: Buffer): Buffer {
  return raw;
}
```

- [ ] **Step 3: Update the renderer to emit raw PCM (only if you chose this path)**

In `scripts/render-fillers.ts`, replace `provider.synthesize` with a direct ElevenLabs REST call requesting `output_format=pcm_16000`:

```typescript
const res = await fetch(
  `https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=pcm_16000`,
  {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY ?? '',
      'Content-Type': 'application/json',
      Accept: 'audio/pcm',
    },
    body: JSON.stringify({
      text: filler.text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  }
);
if (!res.ok) throw new Error(`render failed for ${filler.id}: ${res.status}`);
const pcm = Buffer.from(await res.arrayBuffer());
writeFileSync(resolve(outDir, `${filler.id}.pcm`), pcm);
console.log(`rendered ${filler.id} → ${filler.id}.pcm (${pcm.length} bytes)`);
```

(Keeps it self-contained; doesn't depend on the abstract provider.)

- [ ] **Step 4: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/ai/agents/customer-calling/decode-filler.ts scripts/render-fillers.ts
git commit -m "feat(voice): pre-render fillers as raw PCM 16 kHz, no runtime decode"
```

---

### Task 5.9: Write failing test for filler timer race in mediastream-adapter

**Files:**
- Modify: `packages/api/test/telephony/media-streams/mediastream-adapter.test.ts`

- [ ] **Step 1: Append three tests covering the three race scenarios**

```typescript
describe('mediastream-adapter filler engine', () => {
  it('plays a filler when TTS does not start within 250ms', async () => {
    let ttsStarted = false;
    const slowStreamingProvider = {
      synthesize: vi.fn(),
      synthesizeStream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((r) => setTimeout(r, 400));
          ttsStarted = true;
          yield { pcm: Buffer.alloc(640), isFinal: true };
        },
      })),
    };
    const fillerCache = makeFakeFillerCache(['okay', 'got-it']);
    const { adapter, ws } = setupAdapter({
      ttsProvider: slowStreamingProvider,
      fillerCache,
    });
    // ... drive start frame + tts_play side effect ...
    // Wait long enough for both filler + final response.
    await new Promise((r) => setTimeout(r, 500));
    // Expect at least one filler media frame was sent.
    expect(ws.sent.some((f) => f.event === 'media')).toBe(true);
    expect(ttsStarted).toBe(true);
  });

  it('does NOT play a filler when TTS starts within 250ms', async () => {
    const fastStreamingProvider = {
      synthesize: vi.fn(),
      synthesizeStream: vi.fn(() => ({
        async *[Symbol.asyncIterator]() {
          yield { pcm: Buffer.alloc(640), isFinal: false };
          yield { pcm: Buffer.alloc(640), isFinal: true };
        },
      })),
    };
    const fillerCache = makeFakeFillerCache(['okay']);
    let fillerFetched = false;
    const wrappedCache = {
      ...fillerCache,
      get: (id: string) => { fillerFetched = true; return fillerCache.get(id); },
    };
    const { adapter, ws } = setupAdapter({
      ttsProvider: fastStreamingProvider,
      fillerCache: wrappedCache,
    });
    // ... drive start + tts_play ...
    await new Promise((r) => setTimeout(r, 100));
    expect(fillerFetched).toBe(false);
  });

  it('cancels the filler cleanly when the real response arrives mid-filler', async () => {
    // Filler is mid-flight; emitSideEffects starts a real response.
    // Assert: Twilio receives `clear` and the next media frame is from
    // the real response, not the filler.
    // (Implementation depends on the filler integration in adapter.)
  });
});
```

`makeFakeFillerCache` is a small helper — define near other test helpers in the file:

```typescript
function makeFakeFillerCache(ids: string[]): { get: (id: string) => Buffer | undefined; has: (id: string) => boolean; size: () => number } {
  const m = new Map<string, Buffer>();
  for (const id of ids) m.set(id, Buffer.alloc(320));
  return {
    get: (id) => m.get(id),
    has: (id) => m.has(id),
    size: () => m.size,
  };
}
```

- [ ] **Step 2: Run to verify FAIL**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/telephony/media-streams/mediastream-adapter.test.ts -t "filler engine"
```

Expected: FAIL (adapter does not yet know about fillerCache).

---

### Task 5.10: Wire `FillerEngine` + `FillerAudioCache` into `mediastream-adapter`

**Files:**
- Modify: `packages/api/src/telephony/media-streams/mediastream-adapter.ts`

- [ ] **Step 1: Extend deps**

Add to `MediaStreamAdapterDeps`:

```typescript
/**
 * Optional filler engine + cache. When both are present, the adapter
 * wraps each `tts_play` turn with a 250ms timer: if the real TTS has
 * not started streaming by then, it plays one filler clip from the
 * cache. Omitting either turns the feature off entirely.
 */
fillerEngine?: {
  selectNext(ctx?: { skipFillers?: boolean }): { id: string; text: string; approxDurationMs: number } | undefined;
};
fillerCache?: {
  get(id: string): Buffer | undefined;
};
/** Override for the 250ms threshold (ms). Default 250. */
fillerDelayMs?: number;
```

- [ ] **Step 2: Refactor `emitSideEffects` to use a filler wrapper**

Wrap the per-effect TTS body in a helper that runs the TTS synthesis and the filler timer concurrently. Inside `emitSideEffects`, replace the existing per-`tts_play` block with a call to `runTurnWithFiller`. Add this method to the class:

```typescript
private async runTurnWithFiller(
  ttsProvider: TtsProvider,
  text: string,
  turnId: number
): Promise<void> {
  const delayMs = this.deps.fillerDelayMs ?? 250;
  const engine = this.deps.fillerEngine;
  const cache = this.deps.fillerCache;

  let realStarted = false;
  const controller = new AbortController();

  // Schedule a filler if both engine and cache are wired.
  const fillerTimer = engine && cache
    ? setTimeout(() => {
        if (realStarted || turnId !== this.state.outboundTurnId || !this.state.agentSpeaking) {
          return;
        }
        const filler = engine.selectNext();
        if (!filler) return;
        const pcm = cache.get(filler.id);
        if (!pcm) return;
        // Best-effort emission — do not await; if real audio arrives
        // mid-filler, the existing barge-in path is the cancellation.
        void this.streamPcmAsMedia(pcm, turnId).catch(() => undefined);
        if (this.state.session) {
          this.state.session.events.emit(
            VOICE_EVENT_CHANNEL,
            fillerFiredEvent({ fillerText: filler.text }),
          );
        }
      }, delayMs)
    : null;
  if (fillerTimer && typeof fillerTimer.unref === 'function') fillerTimer.unref();

  try {
    if (typeof ttsProvider.synthesizeStream === 'function') {
      const stream = ttsProvider.synthesizeStream({
        text,
        tenantId: this.state.tenantId ?? undefined,
        signal: controller.signal,
      });
      let first = true;
      for await (const chunk of stream) {
        if (turnId !== this.state.outboundTurnId || !this.state.agentSpeaking) {
          controller.abort();
          break;
        }
        if (first && chunk.pcm.length > 0) {
          realStarted = true;
          if (fillerTimer) clearTimeout(fillerTimer);
          first = false;
        }
        if (chunk.pcm.length > 0) {
          await this.streamPcmAsMedia(chunk.pcm, turnId);
        }
        if (chunk.isFinal) break;
      }
    } else {
      const result = await ttsProvider.synthesize({
        text,
        tenantId: this.state.tenantId ?? undefined,
      });
      realStarted = true;
      if (fillerTimer) clearTimeout(fillerTimer);
      if (turnId === this.state.outboundTurnId && this.state.agentSpeaking) {
        await this.streamPcmAsMedia(result.audio, turnId);
      }
    }
  } finally {
    if (fillerTimer) clearTimeout(fillerTimer);
  }
}
```

Add import:

```typescript
import { fillerFiredEvent } from '../../ai/voice-quality/events';
```

Inside the existing `emitSideEffects` loop, replace the per-`tts_play` synthesis body with:

```typescript
for (const fx of sideEffects) {
  if (fx.type === 'emit_quality_event' && this.state.session) {
    // ... (existing repair-template handler from Task 5.2) ...
    continue;
  }
  if (fx.type !== 'tts_play') continue;
  const text = typeof fx.payload.text === 'string' ? fx.payload.text : '';
  if (!text) continue;
  const turnId = ++this.state.outboundTurnId;
  this.state.agentSpeaking = true;
  try {
    await this.runTurnWithFiller(ttsProvider, text, turnId);
  } catch (err) {
    logger.warn('mediastream: TTS turn failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (turnId === this.state.outboundTurnId) {
      this.state.agentSpeaking = false;
    }
  }
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Run the filler tests**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/telephony/media-streams/mediastream-adapter.test.ts -t "filler engine"
```

Expected: tests pass. If the third (cancellation) test still has gaps, mark it `it.todo` and create a follow-up issue — the spec acknowledges the cancellation logic is the hardest part.

- [ ] **Step 5: Run the full mediastream-adapter test file**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run test/telephony/media-streams/mediastream-adapter.test.ts
```

Expected: all pre-existing tests still pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/telephony/media-streams/mediastream-adapter.ts packages/api/test/telephony/media-streams/mediastream-adapter.test.ts
git commit -m "feat(voice): wrap TTS turns with 250ms filler timer + race cancellation"
```

---

### Task 5.11: Wire `FillerEngine` and `FillerAudioCache` into app bootstrap

**Files:**
- Modify: whichever bootstrap file wires `MediaStreamAdapterDeps` (located in Task 2.8)

- [ ] **Step 1: Construct and pass the engine + cache**

In the bootstrap file (likely `app.ts`):

```typescript
import { FillerEngine } from './ai/agents/customer-calling/filler-engine';
import { FillerAudioCache } from './ai/agents/customer-calling/filler-audio-cache';
import { resolve } from 'node:path';

const fillerCache = new FillerAudioCache(
  resolve(__dirname, 'ai/agents/customer-calling/fillers')
);
fillerCache.load();

// One engine per call would be ideal for non-repeat tracking; for now,
// use a single engine instance — repetition across calls is fine since
// callers do not hear each other's prior fillers.
const fillerEngine = new FillerEngine();

// ... in the MediaStreamAdapterDeps assembly:
{
  store,
  streamingProvider,
  ttsProvider,
  speechTurn,
  initializeSession,
  terminologyProvider,
  fillerEngine,
  fillerCache,
}
```

- [ ] **Step 2: Run typecheck**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/macmini/Serviceos/Serviceos
git add packages/api/src/app.ts
git commit -m "feat(voice): wire FillerEngine + FillerAudioCache into bootstrap"
```

---

## Section 6 — Integration & PR Prep

### Task 6.1: Run the full test suite

**Files:** none

- [ ] **Step 1: Run typecheck against the production tsconfig**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx tsc --project tsconfig.build.json --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Run the full vitest suite**

```bash
cd /Users/macmini/Serviceos/Serviceos/packages/api && npx vitest run
```

Expected: all green. Address any unrelated regressions; do NOT mark the task complete with broken tests.

### Task 6.2: Manually render fillers against a real ElevenLabs key (one-time setup step for first deployer)

**Files:** generated assets — not committed

- [ ] **Step 1: Render**

```bash
cd /Users/macmini/Serviceos/Serviceos
ELEVENLABS_API_KEY=<paste-key> TTS_PROVIDER=elevenlabs \
  npx tsx scripts/render-fillers.ts
```

Expected: 8 `.pcm` files appear under `packages/api/src/ai/agents/customer-calling/fillers/`.

- [ ] **Step 2: Manually listen to each filler**

```bash
# macOS — pipe raw PCM into sox or afplay; rough check that they sound right.
for f in packages/api/src/ai/agents/customer-calling/fillers/*.pcm; do
  echo "$f"
  sox -t raw -r 16000 -b 16 -c 1 -e signed-integer "$f" -t coreaudio
done
```

If `sox` is unavailable, skip the listening step but verify each file has non-zero size:

```bash
ls -la packages/api/src/ai/agents/customer-calling/fillers/
```

### Task 6.3: Open the PR

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
cd /Users/macmini/Serviceos/Serviceos
git push -u origin feat/sound-human-voice
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --title "feat(voice): Sound Human — streaming TTS, keyword boost, repair templates, fillers" --body "$(cat <<'EOF'
## Summary
- Replaces buffered ElevenLabs REST TTS with WebSocket streaming, removing 400-800ms of pre-first-frame latency.
- Adds Deepgram keyword boost from vertical packs so HVAC/plumbing jargon isn't clipped or mis-transcribed; tightens endpointing to 600ms.
- Replaces generic "say that again?" reprompts with vertical-specific repair templates (heating vs cooling, emergency vs scheduling, etc.).
- Adds a 250ms backchannel/filler engine: if real TTS hasn't started streaming by then, plays a pre-rendered "mm-hmm" or "let me check" clip so the caller never hears dead air.
- One-line change: greetings always end with a conversational prompt cue.

Spec: docs/superpowers/specs/2026-05-16-sound-human-voice-design.md
Plan: docs/superpowers/plans/2026-05-16-sound-human-voice.md

## Test plan
- [ ] All unit tests green (vitest)
- [ ] Production tsconfig typecheck clean (`tsc --project tsconfig.build.json --noEmit`)
- [ ] One-time: render fillers via `npx tsx scripts/render-fillers.ts` with ELEVENLABS_API_KEY set
- [ ] Manual: place an inbound test call with TWILIO_MEDIA_STREAMS_ENABLED=true and TTS_PROVIDER=elevenlabs; confirm:
  - Greeting plays within ~1s of pickup and ends with "...how can I help?"
  - Pause-after-question is filled with a filler when LLM is slow
  - "Mumble something" triggers a vertical-specific clarification (HVAC: "heating or cooling?")
  - Speaking "compressor" or "heat pump" is transcribed correctly
  - Barging in during agent speech stops the agent within ~200ms
EOF
)"
```

- [ ] **Step 3: Capture the PR URL and report back to the user.**

---

## Self-Review (run before declaring complete)

- [ ] All five spec features (F3, P2-1, P2-2, P2-3, P2-4) have at least one task in this plan.
- [ ] Every code step includes the actual code (no "implement this here" placeholders).
- [ ] Every test step includes the assertion (no "test it works").
- [ ] Type signatures used in later tasks match those defined in earlier tasks.
- [ ] Every file referenced is either created in an earlier task or pre-existing in the repo at the path quoted.
- [ ] Each task ends with a typecheck or test + a commit.
- [ ] No task spans more than ~5 minutes of engineer time per step.
