import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { DeepgramStreamingProvider } from '../../src/voice/transcription-providers';
import { ElevenLabsStreamConnection } from '../../src/ai/tts/elevenlabs-stream';

describe('speech providers on the deployed Node 20 runtime', () => {
  let server: WebSocketServer;
  let baseUrl: string;
  beforeEach(async () => {
    vi.stubGlobal('WebSocket', undefined);
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => server.once('listening', resolve));
    baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens speech recognition and receives a transcript without a global WebSocket', async () => {
    let authHeader: string | undefined;
    let requestUrl: string | undefined;
    server.on('connection', (socket, request) => {
      authHeader = request.headers['sec-websocket-protocol'];
      requestUrl = request.url;
      socket.on('message', () => socket.send(JSON.stringify({
      type: 'Results', is_final: true,
      channel: { alternatives: [{ transcript: 'QA test', confidence: 0.99 }] },
    })));
    });
    const provider = new DeepgramStreamingProvider('fixture-key');
    // Substitute only the remote endpoint; exercise the real public provider.
    vi.spyOn(provider as unknown as { buildWsUrl(): string }, 'buildWsUrl')
      .mockReturnValue(`${baseUrl}/listen?model=nova-3`);
    const onEvent = vi.fn();
    const session = await provider.openSession(onEvent, vi.fn(), vi.fn());
    session.send(Buffer.alloc(32));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ transcript: 'QA test', isFinal: true })));
    expect(authHeader).toBe('token,fixture-key');
    expect(requestUrl).not.toContain('fixture-key');
    session.destroy();
  });

  it('streams real PCM frames from the TTS protocol without a global WebSocket', async () => {
    const pcm = Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]);
    server.on('connection', socket => socket.on('message', data => {
      if (JSON.parse(String(data)).text === '') {
        socket.send(JSON.stringify({ audio: pcm.toString('base64'), isFinal: true }));
        socket.close();
      }
    }));
    const provider = new ElevenLabsStreamConnection({
      apiKey: 'fixture-key', voiceId: 'fixture-voice', modelId: 'fixture-model', baseUrl,
    });
    const chunks = [];
    for await (const chunk of provider.synthesize({ text: 'QA test' })) chunks.push(chunk);
    expect(Buffer.concat(chunks.map(chunk => chunk.pcm))).toEqual(pcm);
    expect(chunks.at(-1)?.isFinal).toBe(true);
  });
});
