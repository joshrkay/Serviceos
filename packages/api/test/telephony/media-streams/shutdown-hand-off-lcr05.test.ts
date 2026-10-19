/**
 * LCR-05 — on shutdown, live realtime calls are handed to the next process
 * instead of being hung up.
 *
 * A realtime (media-streams) call has no next webhook: when the process that
 * holds its stream goes away, nothing follows `</Connect>` and Twilio ends the
 * call. Every voice deploy therefore hung up the calls still live after the
 * drain window. runShutdown now first moves each live realtime call over to
 * the Gather fallback through the adapter's own degrade (REST redirect to
 * /voice/gather-fallback); that request reaches the new deployment, which
 * starts the call over as a fresh disclosed Gather session.
 *
 * Pinned here, against real adapters and a real session store with a spy
 * redirector:
 *   - one redirect per live realtime call, none for Gather-only sessions;
 *   - the old leg stamps no terminal outcome (no dropped-call text to a
 *     caller who is still on the line) and its session stops counting as live,
 *     so the drain does not wait out its window and page on a handed-off call;
 *   - a refused or timed-out redirect leaves the session live (today's drain);
 *   - a Twilio `stop` that lands while the redirect is still in flight does
 *     not stamp an outcome either;
 *   - a hung redirect cannot hold shutdown past the hand-off bound;
 *   - the server tracks every live leg and forgets it when it closes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { resolve } from 'path';

vi.mock('../../../src/analytics/posthog', () => ({
  recordVoiceError: () => {},
}));

import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import { attachMediaStreamServer, MEDIA_STREAM_PATH } from '../../../src/telephony/media-streams/twilio-mediastream-server';
import { createLiveRealtimeCalls } from '../../../src/telephony/media-streams/live-realtime-calls';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
} from '../../../src/voice/transcription-providers';
import { InMemoryAuditRepository } from '../../../src/audit/audit';

class FakeWs implements WsLike {
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(): void {}
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.fire('close');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) l(...args);
  }
  inboundJson(obj: unknown): void {
    this.fire('message', JSON.stringify(obj));
  }
}

function okStreamingProvider(): StreamingTranscriptionProvider {
  const session: StreamingSession = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
  return { openSession: vi.fn(() => Promise.resolve(session)) };
}

const START_FRAME = (callSid: string, streamSid: string) => ({
  event: 'start' as const,
  streamSid,
  start: { callSid, accountSid: 'AC-sub', streamSid, tracks: ['inbound'] },
});

const flush = () => new Promise((r) => setImmediate(r));

let store: VoiceSessionStore;
let auditRepo: InMemoryAuditRepository;
beforeEach(() => {
  store = new VoiceSessionStore({ startInterval: false });
  auditRepo = new InMemoryAuditRepository();
});
afterEach(() => store.dispose());

/** A live realtime leg: session in the store, stream started, leg tracked. */
async function liveLeg(
  liveCalls: ReturnType<typeof createLiveRealtimeCalls>,
  callSid: string,
  restRedirect: (args: { callSid: string; accountSid?: string }) => Promise<boolean | 'unknown'>,
  finalizeOnClose = vi.fn(),
) {
  const session = store.create('tenant-lcr05', 'telephony', { callSid });
  const ws = new FakeWs();
  const adapter = new TwilioMediaStreamAdapter(
    {
      store,
      streamingProvider: okStreamingProvider(),
      speechTurn: async () => [],
      initializeSession: async () => [],
      finalizeOnClose,
      restRedirect,
      auditRepo,
    },
    ws,
  );
  adapter.start();
  const forget = liveCalls.add(adapter);
  ws.on('close', forget);
  ws.inboundJson(START_FRAME(callSid, `MZ-${callSid}`));
  await flush();
  await flush();
  return { session, ws, adapter, finalizeOnClose };
}

describe('LCR-05 — handOffAll moves every live realtime call to the Gather fallback', () => {
  it('one redirect per live realtime call; no outcome stamped; sessions stop counting as live', async () => {
    const liveCalls = createLiveRealtimeCalls();
    const restRedirect = vi.fn().mockResolvedValue(true);
    const a = await liveLeg(liveCalls, 'CA-live-a', restRedirect);
    const b = await liveLeg(liveCalls, 'CA-live-b', restRedirect);
    // A Gather-only call on this process: never redirected (a redirect would
    // cut the caller off mid-sentence); its next /gather restarts it.
    store.create('tenant-lcr05', 'telephony', { callSid: 'CA-gather-only' });
    expect(store.liveCount()).toBe(3);
    expect(liveCalls.size()).toBe(2);

    const result = await liveCalls.handOffAll({ timeoutMs: 1_000 });

    expect(result).toEqual({ attempted: 2, handedOff: 2 });
    expect(restRedirect).toHaveBeenCalledTimes(2);
    expect(restRedirect.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        { callSid: 'CA-live-a', accountSid: 'AC-sub' },
        { callSid: 'CA-live-b', accountSid: 'AC-sub' },
      ]),
    );
    for (const leg of [a, b]) {
      expect(leg.ws.closeCode).toBe(1000);
      expect(leg.ws.closeReason).toBe('degraded_to_gather');
      // No terminal outcome on a call that continues on the new process.
      expect(leg.finalizeOnClose).not.toHaveBeenCalled();
      expect(leg.session.terminalOutcome).toBeUndefined();
      expect(leg.session.ended).toBe(true);
    }
    // Only the Gather-only call is still live: the drain waits on it alone.
    expect(store.liveCount()).toBe(1);
    expect(store.liveCallSids()).toEqual(['CA-gather-only']);
    // Closed legs are forgotten.
    expect(liveCalls.size()).toBe(0);
    // Each hand-off is on the record with its cause.
    const degraded = (await auditRepo.findByEntity('tenant-lcr05', 'voice_session', 'CA-live-a')).filter(
      (e) => e.eventType === 'voice.realtime.degraded_to_gather',
    );
    expect(degraded).toHaveLength(1);
    expect(degraded[0].metadata).toMatchObject({ reason: 'deploy_shutdown' });
  });

  it('a refused redirect leaves the call live (the drain waits for it as before)', async () => {
    const liveCalls = createLiveRealtimeCalls();
    const leg = await liveLeg(liveCalls, 'CA-refused', vi.fn().mockResolvedValue(false));
    const result = await liveCalls.handOffAll({ timeoutMs: 1_000 });
    expect(result).toEqual({ attempted: 1, handedOff: 0 });
    expect(leg.ws.closed).toBe(false);
    expect(leg.session.ended).toBe(false);
    expect(store.liveCallSids()).toEqual(['CA-refused']);
  });

  it("a timed-out redirect ('unknown') is not counted as handed off and leaves the session live", async () => {
    const liveCalls = createLiveRealtimeCalls();
    const leg = await liveLeg(liveCalls, 'CA-unknown', vi.fn().mockResolvedValue('unknown'));
    const result = await liveCalls.handOffAll({ timeoutMs: 1_000 });
    expect(result).toEqual({ attempted: 1, handedOff: 0 });
    expect(leg.session.ended).toBe(false);
  });

  it('a Twilio stop that arrives while the redirect is in flight stamps no outcome', async () => {
    const liveCalls = createLiveRealtimeCalls();
    let accept!: (v: boolean) => void;
    const restRedirect = vi.fn(
      () => new Promise<boolean>((r) => { accept = r; }),
    );
    const leg = await liveLeg(liveCalls, 'CA-race', restRedirect);
    const pending = liveCalls.handOffAll({ timeoutMs: 1_000 });
    await flush();
    // Twilio applies the redirect and ends the stream before the REST
    // response lands.
    leg.ws.inboundJson({ event: 'stop', streamSid: 'MZ-CA-race' });
    leg.ws.close(1005, '');
    await flush();
    accept(true);
    expect(await pending).toEqual({ attempted: 1, handedOff: 1 });
    expect(leg.finalizeOnClose).not.toHaveBeenCalled();
    expect(leg.session.terminalOutcome).toBeUndefined();
    expect(leg.session.ended).toBe(true);
  });

  it('a close during an in-flight redirect that is then refused is settled as a normal close', async () => {
    const liveCalls = createLiveRealtimeCalls();
    let refuse!: (v: boolean) => void;
    const restRedirect = vi.fn(
      () => new Promise<boolean>((r) => { refuse = r; }),
    );
    const leg = await liveLeg(liveCalls, 'CA-race-refused', restRedirect);
    const pending = liveCalls.handOffAll({ timeoutMs: 1_000 });
    await flush();
    // The caller hung up; the redirect then fails because the call is gone.
    leg.ws.inboundJson({ event: 'stop', streamSid: 'MZ-CA-race-refused' });
    await flush();
    refuse(false);
    expect(await pending).toEqual({ attempted: 1, handedOff: 0 });
    expect(leg.finalizeOnClose).toHaveBeenCalledTimes(1);
  });

  it('a hung redirect cannot hold shutdown past the hand-off bound', async () => {
    const liveCalls = createLiveRealtimeCalls();
    await liveLeg(liveCalls, 'CA-hung', vi.fn(() => new Promise<boolean>(() => {})));
    const started = Date.now();
    const result = await liveCalls.handOffAll({ timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({ attempted: 1, handedOff: 0 });
  });

  it('with no live realtime calls it does nothing', async () => {
    const liveCalls = createLiveRealtimeCalls();
    expect(await liveCalls.handOffAll({ timeoutMs: 50 })).toEqual({ attempted: 0, handedOff: 0 });
  });
});

describe('LCR-05 — attachMediaStreamServer tracks live legs for the shutdown hand-off', () => {
  let server: http.Server;
  let port: number;
  let dispose: () => void = () => {};

  beforeEach(async () => {
    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    dispose();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('adds the leg when the stream upgrades and forgets it when the stream closes', async () => {
    const liveCalls = createLiveRealtimeCalls();
    ({ dispose } = attachMediaStreamServer(server, {
      store,
      streamingProvider: okStreamingProvider(),
      speechTurn: async () => [],
      authTokenGetter: () => 'unused',
      authTestMode: true,
      liveCalls,
    }));
    const req = http.request({
      port,
      path: MEDIA_STREAM_PATH,
      headers: {
        Host: `127.0.0.1:${port}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    const socket = await new Promise<import('net').Socket>((res, rej) => {
      req.on('upgrade', (_r, s) => res(s));
      req.on('error', rej);
      req.end();
    });
    try {
      await flush();
      expect(liveCalls.size()).toBe(1);
    } finally {
      socket.destroy();
    }
    for (let i = 0; i < 50 && liveCalls.size() > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(liveCalls.size()).toBe(0);
  });
});

describe('LCR-05 — runShutdown hands live realtime calls off before it drains (source-level)', () => {
  // createApp() keeps the registry in its closure (no seam to inject a live
  // leg), so — like the WS15 drain pins in test/app/graceful-shutdown.test.ts —
  // the wiring is pinned on the source; the behaviour is pinned above.
  const appSrc = readFileSync(resolve(__dirname, '../../../src/app.ts'), 'utf8');
  const shutdown = appSrc.slice(appSrc.indexOf('const runShutdown = async'));

  it('the hand-off runs inside the drain window, before the drain loop and the teardown', () => {
    const deadline = shutdown.indexOf('const drainDeadline = ');
    const handOff = shutdown.indexOf('liveRealtimeCalls.handOffAll(');
    const loop = shutdown.indexOf('while (voiceSessionStore.liveCount() > 0');
    const teardown = shutdown.indexOf('voiceSessionStore.dispose()');
    expect(deadline).toBeGreaterThan(-1);
    expect(handOff).toBeGreaterThan(deadline);
    expect(loop).toBeGreaterThan(handOff);
    expect(teardown).toBeGreaterThan(loop);
  });

  it('the same registry is the one the stream server fills', () => {
    expect(appSrc).toMatch(/const liveRealtimeCalls = createLiveRealtimeCalls\(\)/);
    expect(appSrc).toMatch(/attachMediaStreamServer\(\s*server,\s*\{[\s\S]*?liveCalls: liveRealtimeCalls,/);
  });
});
