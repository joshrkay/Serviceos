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

  it('VOX-33: rejects when the stream stalls with no frame within the inactivity bound', async () => {
    // WS opens but never emits a message and never closes — a silent stall.
    // Without a timer the `for await` would hang until the 30-min call idle
    // timeout. With the per-frame bound, next() must reject.
    const conn = new ElevenLabsStreamConnection({
      apiKey: 'k',
      voiceId: 'v',
      modelId: 'm',
      inactivityTimeoutMs: 20, // tiny bound to keep the test fast
    });
    const iter = conn.synthesize({ text: 'hello' })[Symbol.asyncIterator]();
    await Promise.resolve(); // let 'open' fire
    // No frames pushed → the pending next() should reject within ~20ms and
    // close the socket.
    await expect(iter.next()).rejects.toThrow(/inactivity timeout/i);
    expect(ws.readyState).toBe(3); // socket closed on stall
  });

  it('VOX-35a: delivers already-queued PCM chunks even when a WS error fires after them', async () => {
    // Two valid audio frames are queued, THEN the WS errors. The old order
    // checked errorState before draining the queue, discarding good audio
    // (dead air). The consumer must still receive both queued chunks; the
    // error only surfaces after they are exhausted.
    const conn = new ElevenLabsStreamConnection({
      apiKey: 'k',
      voiceId: 'v',
      modelId: 'm',
    });
    const iter = conn.synthesize({ text: 'hi' })[Symbol.asyncIterator]();
    await Promise.resolve(); // 'open'

    const audio = Buffer.from([1, 2, 3, 4]).toString('base64');
    // Queue two frames with NO pending waiter, then fire an error.
    ws.fire('message', { data: JSON.stringify({ audio }) });
    ws.fire('message', { data: JSON.stringify({ audio }) });
    ws.fire('error', {}); // sets errorState + closes ws → 'close' → finish()

    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value.pcm.length).toBe(4);
    const second = await iter.next();
    expect(second.done).toBe(false);
    expect(second.value.pcm.length).toBe(4);
    // Only AFTER the buffered audio is drained does the error surface.
    await expect(iter.next()).rejects.toThrow(/ElevenLabs WS error/);
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
