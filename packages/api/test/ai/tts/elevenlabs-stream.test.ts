import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElevenLabsStreamConnection, looksLikeMp3 } from '../../../src/ai/tts/elevenlabs-stream';

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
    // Regular function (not an arrow) so the mock is constructable — the
    // connection helper calls `new WebSocket(...)`, and vitest 4's spy
    // forwards `new` to the implementation via Reflect.construct, which
    // rejects non-constructable arrow functions.
    global.WebSocket = vi.fn(function () {
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
    // T2-F01: the endpoint DEFAULTS to mp3_44100 — the PCM pin must be in
    // the URL or every downstream consumer decodes MP3 bytes as raw PCM.
    expect(global.WebSocket).toHaveBeenCalledWith(
      expect.stringContaining('output_format=pcm_16000')
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

  it('T2-F01: rejects the turn when the first audio frame is MP3 (ID3 tag) instead of PCM', async () => {
    const conn = new ElevenLabsStreamConnection({ apiKey: 'k', voiceId: 'v', modelId: 'm' });
    const iter = conn.synthesize({ text: 'hi' })[Symbol.asyncIterator]();
    await Promise.resolve(); // 'open'
    const id3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'binary').toString('base64');
    ws.fire('message', { data: JSON.stringify({ audio: id3 }) });
    await expect(iter.next()).rejects.toThrow(/compressed \(MP3\) audio/i);
    expect(ws.readyState).toBe(3); // socket closed — never plays static
  });

  it('T2-F01: rejects the turn when the first audio frame carries a valid MP3 frame header', async () => {
    const conn = new ElevenLabsStreamConnection({ apiKey: 'k', voiceId: 'v', modelId: 'm' });
    const iter = conn.synthesize({ text: 'hi' })[Symbol.asyncIterator]();
    await Promise.resolve();
    // 0xFF 0xFB 0x90 0x44 — MPEG-1 Layer III, 128kbps, 44.1kHz: the typical
    // first bytes of an ElevenLabs mp3_44100 stream chunk.
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00]).toString('base64');
    ws.fire('message', { data: JSON.stringify({ audio: mp3 }) });
    await expect(iter.next()).rejects.toThrow(/compressed \(MP3\) audio/i);
  });

  it('T2-F01: does NOT misflag near-silent PCM that starts with 0xFF byte runs', async () => {
    // PCM16LE sample value -1 is bytes FF FF — a bare frame-sync check would
    // misread a quiet stream start as MP3 and kill a healthy turn. The
    // bitrate-nibble validity check (0xF = invalid) must let this through.
    const conn = new ElevenLabsStreamConnection({ apiKey: 'k', voiceId: 'v', modelId: 'm' });
    const iter = conn.synthesize({ text: 'hi' })[Symbol.asyncIterator]();
    await Promise.resolve();
    const quietPcm = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01, 0x00]).toString('base64');
    ws.fire('message', { data: JSON.stringify({ audio: quietPcm }) });
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value.pcm.length).toBe(6);
  });

  it('looksLikeMp3 classifies signatures correctly', () => {
    expect(looksLikeMp3(Buffer.from('ID3rest'))).toBe(true);
    // Short chunk with a strict MPEG-1 Layer III header — no room to verify
    // the next sync, so it must still classify as MP3.
    expect(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x44]))).toBe(true);
    expect(looksLikeMp3(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(false); // PCM -1,-1 (layer bits ≠ III)
    expect(looksLikeMp3(Buffer.from([0xff, 0xff, 0x40, 0x00]))).toBe(false); // PCM -1 then +64 (review case)
    expect(looksLikeMp3(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe(false); // silence
    expect(looksLikeMp3(Buffer.from([0xff, 0xe1, 0x90, 0x44]))).toBe(false); // layer bits 00 = reserved
    expect(looksLikeMp3(Buffer.alloc(2))).toBe(false); // too short to classify

    // Long chunks: MPEG-1 L3 @128kbps/44.1kHz → frame size 417. A real MP3
    // repeats the sync word at the frame boundary; PCM coincidences don't.
    const frame = Buffer.alloc(420);
    frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x44;
    frame[417] = 0xff; frame[418] = 0xfb;
    expect(looksLikeMp3(frame)).toBe(true); // sync repeats → MP3
    const coincidence = Buffer.alloc(420);
    coincidence[0] = 0xff; coincidence[1] = 0xfb; coincidence[2] = 0x90; coincidence[3] = 0x44;
    expect(looksLikeMp3(coincidence)).toBe(false); // no repeat sync → loud PCM, not MP3
  });

  it('T2-F01: a runt (<4 byte) first frame does not consume the format check', async () => {
    const conn = new ElevenLabsStreamConnection({ apiKey: 'k', voiceId: 'v', modelId: 'm' });
    const iter = conn.synthesize({ text: 'hi' })[Symbol.asyncIterator]();
    await Promise.resolve();
    ws.fire('message', { data: JSON.stringify({ audio: Buffer.from([0x00, 0x01]).toString('base64') }) });
    const runt = await iter.next();
    expect(runt.done).toBe(false); // runt frame still delivered
    const id3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'binary').toString('base64');
    ws.fire('message', { data: JSON.stringify({ audio: id3 }) });
    // The classifiable second frame must still be checked and rejected.
    await expect(iter.next()).rejects.toThrow(/compressed \(MP3\) audio/i);
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
