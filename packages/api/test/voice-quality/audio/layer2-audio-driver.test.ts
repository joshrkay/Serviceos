/**
 * #1387 — Layer 2 audio driver wiring.
 *
 * Weekly Layer 2 run 35600368305 reported, for all 40 scripts,
 * durationMedianMs = 0, ttfaMedianMs = 0 and disposition 0/40 even though
 * each script ran for 14–94 s of wall clock. Cause: the live entry built the
 * emulator / Whisper provider / AudioModeDriver on a private bus, while
 * `runScript` builds the graded observation from the bus it hands the driver
 * factory. The graders therefore saw only the runner's synthetic
 * `session_terminated` event — no timing, no intent, no agent speech.
 *
 * Seam: `createLayer2AudioDriver(bus, deps)` driven through the real
 * `runScript`. The observation must carry what the audio path recorded.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { createLayer2AudioDriver } from '../../../src/ai/voice-quality/audio/layer2-audio-driver';
import { TtsFixtureCache } from '../../../src/ai/voice-quality/audio/tts-fixture-cache';
import { pcm16ToMulaw } from '../../../src/ai/voice-quality/audio/pcm-codec';
import { runScript } from '../../../src/ai/voice-quality/runner';
import type { VoiceQualityScript } from '../../../src/ai/voice-quality/schema';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { TtsProvider } from '../../../src/ai/tts/tts-provider';

/** Stub media-streams server: answers each caller `mark` with one agent frame. */
function startReplyingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const httpServer: HttpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    const pcm = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) pcm.writeInt16LE(1000, i * 2);
    const payload = pcm16ToMulaw(pcm).toString('base64');
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf-8')) as { event?: string };
        if (msg.event === 'mark') {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ event: 'media', media: { payload } }));
            }
          }, 30);
        }
      });
    });
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}/stream`,
        close: () =>
          new Promise<void>((r) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => httpServer.close(() => r()));
          }),
      });
    });
  });
}

const fakeTts: TtsProvider = {
  async synthesize() {
    return {
      audio: Buffer.from('not-really-mp3'),
      contentType: 'audio/mpeg',
      provider: 'fake',
    } as Awaited<ReturnType<TtsProvider['synthesize']>>;
  },
};

const script: VoiceQualityScript = {
  id: 'layer2-wiring-1387',
  bucket: '01-happy-lookups',
  fixtures: { tenant: { id: 't_layer2_wiring' }, customers: [] },
  callerId: '+15555550100',
  callerIdBlocked: false,
  turns: [
    { caller: 'What do I owe?', expected: { intent: 'lookup_invoices' }, hangupAfter: false },
  ],
  grading: { appliesFloor: [1], appliesDisposition: [9] },
  layer2Eligible: true,
  layer2Only: false,
  callerIsOwner: false,
};

describe('#1387 — createLayer2AudioDriver', () => {
  let server: { url: string; close: () => Promise<void> };
  let cacheDir: string;
  let store: VoiceSessionStore;

  beforeEach(async () => {
    server = await startReplyingServer();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-l2-wiring-'));
    store = new VoiceSessionStore({ startInterval: false });
  });

  afterEach(async () => {
    store.dispose();
    await server.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('records the audio path onto the bus runScript grades from', async () => {
    const disposers: Array<() => Promise<void>> = [];

    const { observation } = await runScript(script, {
      repoMode: 'memory',
      driverFactory: (factoryCtx) => {
        const built = createLayer2AudioDriver(factoryCtx.bus, {
          serverUrl: server.url,
          voiceSessionStore: store,
          ttsCache: new TtsFixtureCache({ ttsProvider: fakeTts, cacheDir }),
          whisperTranscriber: {
            async transcribeBuffer() {
              return { transcript: 'You owe forty dollars.', metadata: {} };
            },
          },
          costTracker: { addCents: () => {}, totalCents: () => 0 },
          decodeTtsAudio: async () => Buffer.alloc(640),
          silenceWindowMs: 100,
          firstAudioTimeoutMs: 1_000,
        });
        disposers.push(built.dispose);
        return built.driver;
      },
    });
    for (const d of disposers) await d();

    const types = observation.events.map((e) => e.type);
    // Timing start for TTFA (the emulator records it when no STT bridge is wired).
    expect(types).toContain('transcript_received');
    // The Whisper-recovered agent reply the perceived-completion judge reads.
    const outbound = observation.events.find((e) => e.type === 'speech_outbound');
    expect(outbound).toMatchObject({ transcript: 'You owe forty dollars.', turnIndex: 0 });
  });
});
