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
