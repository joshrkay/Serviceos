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
 *   - a call that is ending or being handed off is left to finish;
 *   - the server tracks every live leg and forgets it when it closes.
 *
 * runShutdown's own use of the registry (each live leg asked once, inside the
 * drain window) is pinned behaviourally in test/app/shutdown-hand-off-lcr05.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';

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
  StreamingTranscriptCallback,
} from '../../../src/voice/transcription-providers';
import type { VoiceSession } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';
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

const flush = () => new Promise<void>((r) => { setImmediate(r); });

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

/**
 * A live leg that runs one caller turn: `speechTurn` decides what the agent
 * says, the TTS plays it (Twilio never acks the marks here, so the line is
 * still "playing" for `handoffPlayoutMaxWaitMs`), and an optional parked
 * transfer is handed off after the line, as the FSM's escalation does.
 */
async function turnLeg(
  liveCalls: ReturnType<typeof createLiveRealtimeCalls>,
  callSid: string,
  opts: {
    speechTurn: (args: { session: VoiceSession }) => Promise<SideEffect[]> | SideEffect[];
    parkedTransfer?: string;
  },
) {
  const session = store.create('tenant-lcr05', 'telephony', { callSid });
  session.recordingDisclosed = true;
  const ws = new FakeWs();
  let emit: StreamingTranscriptCallback | null = null;
  const sttSession: StreamingSession = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
  const streamingProvider: StreamingTranscriptionProvider = {
    openSession: vi.fn((cb: StreamingTranscriptCallback) => {
      emit = cb;
      return Promise.resolve(sttSession);
    }),
  };
  const synthesize = vi.fn(async () => ({
    audio: Buffer.alloc(640 * 30),
    contentType: 'audio/pcm',
    provider: 'test',
  }));
  const restRedirect = vi.fn(
    async (_args: { callSid: string; accountSid?: string; twiml?: string }): Promise<boolean> => true,
  );
  // The turn parks the transfer (as the FSM's notify_oncall does), not the call's start.
  let parked: string | undefined;
  const finalizeOnClose = vi.fn();
  const adapter = new TwilioMediaStreamAdapter(
    {
      store,
      streamingProvider,
      ttsProvider: { synthesize },
      speechTurn: async ({ session: s }) => {
        const effects = await opts.speechTurn({ session: s });
        if (opts.parkedTransfer) parked = opts.parkedTransfer;
        return effects;
      },
      initializeSession: async () => [],
      finalizeOnClose,
      restRedirect,
      auditRepo,
      handoffPlayoutMaxWaitMs: 300,
      takePendingTransferTwiml: () => {
        const t = parked;
        parked = undefined;
        return t;
      },
      setPendingTransferTwiml: (_id: string, twiml: string) => {
        parked = twiml;
      },
    },
    ws,
  );
  adapter.start();
  const forget = liveCalls.add(adapter);
  ws.on('close', forget);
  ws.inboundJson(START_FRAME(callSid, `MZ-${callSid}`));
  await vi.waitFor(() => expect(emit).not.toBeNull());
  const say = (transcript: string) =>
    emit!({ type: 'final', isFinal: true, transcript, confidence: 0.95 });
  // A bare redirect (no inline TwiML) is the move to the Gather fallback.
  const gatherRedirects = () => restRedirect.mock.calls.filter((c) => c[0].twiml === undefined);
  return { session, ws, say, synthesize, restRedirect, gatherRedirects, finalizeOnClose };
}

describe('LCR-05 — a call that is ending or being handed off is left to finish, not restarted', () => {
  const DIAL = '<Response><Dial><Number>+15125550101</Number></Dial></Response>';

  it('a hand-off waiting for "let me connect you" to play: no redirect; its <Dial> is delivered after the line', async () => {
    const liveCalls = createLiveRealtimeCalls();
    const leg = await turnLeg(liveCalls, 'CA-handoff', {
      speechTurn: () => [{ type: 'tts_play', payload: { text: 'Let me connect you with a team member.' } }],
      parkedTransfer: DIAL,
    });
    leg.say('can I talk to a person');
    await vi.waitFor(() => expect(leg.synthesize).toHaveBeenCalled());
    await flush();

    const result = await liveCalls.handOffAll({ timeoutMs: 1_000 });

    expect(result).toEqual({ attempted: 1, handedOff: 0 });
    expect(leg.gatherRedirects()).toHaveLength(0);
    // The drain window lets the hand-off deliver its transfer over REST.
    await vi.waitFor(() => expect(leg.restRedirect).toHaveBeenCalledTimes(1));
    expect(leg.restRedirect.mock.calls[0][0].twiml).toBe(DIAL);
  });

  it('an E1 911 script still playing: no redirect, and the leg closes stamped life_safety_e1', async () => {
    const liveCalls = createLiveRealtimeCalls();
    const e1: SideEffect[] = [
      { type: 'tts_play', payload: { text: 'Please hang up and call 911 right away.' } },
      { type: 'end_session', payload: { reason: 'life_safety_e1' } },
    ];
    const leg = await turnLeg(liveCalls, 'CA-e1', { speechTurn: () => e1 });
    leg.say('I smell gas in the basement');
    await vi.waitFor(() => expect(leg.synthesize).toHaveBeenCalled());
    await flush();

    const result = await liveCalls.handOffAll({ timeoutMs: 1_000 });

    expect(result).toEqual({ attempted: 1, handedOff: 0 });
    await vi.waitFor(() => expect(leg.ws.closed).toBe(true));
    expect(leg.restRedirect).not.toHaveBeenCalled();
    expect(leg.finalizeOnClose).toHaveBeenCalledTimes(1);
    expect(leg.finalizeOnClose.mock.calls[0][2]).toEqual(
      expect.arrayContaining([expect.objectContaining({ payload: { reason: 'life_safety_e1' } })]),
    );
  });

  it('a goodbye still playing (end_session pending): no redirect, the call ends as it was going to', async () => {
    const liveCalls = createLiveRealtimeCalls();
    const leg = await turnLeg(liveCalls, 'CA-bye', {
      speechTurn: () => [
        { type: 'tts_play', payload: { text: 'Thanks for calling, goodbye.' } },
        { type: 'end_session', payload: { reason: 'closed' } },
      ],
    });
    leg.say('that is all, thanks');
    await vi.waitFor(() => expect(leg.synthesize).toHaveBeenCalled());
    await flush();

    expect(await liveCalls.handOffAll({ timeoutMs: 1_000 })).toEqual({ attempted: 1, handedOff: 0 });
    await vi.waitFor(() => expect(leg.ws.closed).toBe(true));
    expect(leg.restRedirect).not.toHaveBeenCalled();
    expect(leg.finalizeOnClose).toHaveBeenCalledTimes(1);
  });

  it('the FSM already terminated (a farewell): no redirect', async () => {
    const liveCalls = createLiveRealtimeCalls();
    const leg = await turnLeg(liveCalls, 'CA-farewell', {
      speechTurn: ({ session }) => session.machine.dispatch({ type: 'caller_farewell' }),
    });
    leg.say('goodbye');
    await vi.waitFor(() => expect(leg.session.machine.currentState).toBe('terminated'));
    await flush();

    expect(await liveCalls.handOffAll({ timeoutMs: 1_000 })).toEqual({ attempted: 1, handedOff: 0 });
    await vi.waitFor(() => expect(leg.ws.closed).toBe(true));
    expect(leg.restRedirect).not.toHaveBeenCalled();
    expect(leg.finalizeOnClose).toHaveBeenCalledTimes(1);
  });
});

describe('LCR-05 — attachMediaStreamServer tracks live legs for the shutdown hand-off', () => {
  let server: http.Server;
  let port: number;
  let dispose: () => void = () => {};

  beforeEach(async () => {
    server = http.createServer();
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    dispose();
    await new Promise<void>((r) => { server.close(() => r()); });
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
      await new Promise((r) => { setTimeout(r, 10); });
    }
    expect(liveCalls.size()).toBe(0);
  });
});
