/**
 * WS3 (voice ingestion resilience) — mediastream adapter failure-path tests.
 *
 * Pins the session-establishment resilience contract:
 *   - Deepgram open failure → circuit failure + `voice.realtime.session_failed`
 *     audit + WS closed 1011 (Twilio ends the call). No REST redirect is
 *     wired (floor-only; see the WS3 report).
 *   - Disclosure/greeting bootstrap failure → circuit failure +
 *     `voice.disclosure.init_failed` audit + the call CONTINUES (WS not closed).
 *   - Clean establishment → circuit success, no failure, no resilience audit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// OBS — capture recordVoiceError calls without touching the real PostHog SDK.
const recordVoiceErrorMock = vi.fn();
vi.mock('../../../src/analytics/posthog', () => ({
  recordVoiceError: (...args: unknown[]) => recordVoiceErrorMock(...args),
}));

import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../../src/telephony/media-streams/mediastream-adapter';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
} from '../../../src/voice/transcription-providers';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  RealtimeHealthCircuit,
  type Clock,
} from '../../../src/telephony/realtime-health-circuit';
import { InMemoryConnectionRegistry } from '../../../src/ws/connection-registry';

/** Deterministic clock for the real-circuit trap regression. */
class FakeClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const STOP_FRAME = (streamSid: string) => ({ event: 'stop' as const, streamSid });

class FakeWs implements WsLike {
  sent: unknown[] = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
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
  const session: StreamingSession = {
    send: vi.fn(),
    finish: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    openSession: vi.fn((_onEvent: StreamingTranscriptCallback) => Promise.resolve(session)),
  };
}

function failingStreamingProvider(): StreamingTranscriptionProvider {
  return {
    openSession: vi.fn(() => Promise.reject(new Error('deepgram 503'))),
  };
}

/** Opens cleanly but exposes the `onClose` callback so a test can simulate a
 *  Deepgram-initiated mid-call close. */
function capturingStreamingProvider(): {
  provider: StreamingTranscriptionProvider;
  fireClose: () => void;
} {
  const session: StreamingSession = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
  let onCloseCb: (() => void) | undefined;
  const provider: StreamingTranscriptionProvider = {
    openSession: vi.fn(
      (
        _onEvent: StreamingTranscriptCallback,
        _onError: (err: Error) => void,
        onClose: () => void,
      ) => {
        onCloseCb = onClose;
        return Promise.resolve(session);
      },
    ),
  };
  return { provider, fireClose: () => onCloseCb?.() };
}

/**
 * Multi-open provider for the language-switch cases: records each
 * openSession's callbacks so a test can emit transcripts on the LATEST
 * session and fire a SPECIFIC generation's onClose (the real Deepgram
 * provider fires onClose on the ws 'close' that follows finish()).
 */
function multiSessionStreamingProvider(): {
  provider: StreamingTranscriptionProvider;
  openCount: () => number;
  sessions: Array<{ finish: ReturnType<typeof vi.fn> }>;
  emit: (evt: Parameters<StreamingTranscriptCallback>[0]) => void;
  fireClose: (index: number) => void;
} {
  const onEvents: StreamingTranscriptCallback[] = [];
  const onCloses: Array<() => void> = [];
  const sessions: Array<{ finish: ReturnType<typeof vi.fn> }> = [];
  const provider: StreamingTranscriptionProvider = {
    openSession: vi.fn(
      (
        onEvent: StreamingTranscriptCallback,
        _onError: (err: Error) => void,
        onClose: () => void,
      ) => {
        onEvents.push(onEvent);
        onCloses.push(onClose);
        const session = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
        sessions.push(session);
        return Promise.resolve(session as unknown as StreamingSession);
      },
    ),
  };
  return {
    provider,
    openCount: () => onEvents.length,
    sessions,
    emit: (evt) => onEvents[onEvents.length - 1]?.(evt),
    fireClose: (index) => onCloses[index]?.(),
  };
}

function makeCircuit() {
  return {
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
    isOpen: vi.fn(() => false),
  };
}

const START_FRAME = (callSid: string, streamSid: string) => ({
  event: 'start' as const,
  streamSid,
  start: { callSid, accountSid: 'AC', streamSid, tracks: ['inbound'] },
});

const flush = () => new Promise((r) => setImmediate(r));

let store: VoiceSessionStore;
beforeEach(() => {
  store = new VoiceSessionStore({ startInterval: false });
  recordVoiceErrorMock.mockClear();
});

describe('WS3 mediastream resilience — Deepgram open failure', () => {
  it('trips the circuit, emits voice.realtime.session_failed, and closes 1011', async () => {
    store.create('tenant-dg', 'telephony', { callSid: 'CA-dg' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const auditRepo = new InMemoryAuditRepository();
    const createSpy = vi.spyOn(auditRepo, 'create');
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: failingStreamingProvider(),
        speechTurn: async () => [],
        realtimeCircuit: circuit,
        auditRepo,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-dg', 'MZ-dg'));
    await flush();

    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe('deepgram_open_failed');
    expect(circuit.recordFailure).toHaveBeenCalledWith('deepgram_open_failed');
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const event = createSpy.mock.calls[0][0];
    expect(event.eventType).toBe('voice.realtime.session_failed');
    expect(event.tenantId).toBe('tenant-dg');
    expect(event.entityId).toBe('CA-dg');
    expect(event.metadata).toMatchObject({ callSid: 'CA-dg', reason: 'deepgram_open_failed' });
  });

  it('never throws into the WS handler when auditRepo persist fails', async () => {
    store.create('tenant-dg2', 'telephony', { callSid: 'CA-dg2' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const auditRepo = new InMemoryAuditRepository();
    vi.spyOn(auditRepo, 'create').mockRejectedValue(new Error('pg down'));
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: failingStreamingProvider(),
        speechTurn: async () => [],
        realtimeCircuit: circuit,
        auditRepo,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-dg2', 'MZ-dg2'));
    await flush();

    // Circuit still tripped and the leg still closed even though the audit throw.
    expect(circuit.recordFailure).toHaveBeenCalledWith('deepgram_open_failed');
    expect(ws.closeCode).toBe(1011);
  });
});

describe('WS7 mediastream resilience — mid-call degrade to Gather (REST redirect)', () => {
  it('Deepgram open failure + redirect success → close 1000, degraded audit, circuit still records failure', async () => {
    store.create('tenant-r1', 'telephony', { callSid: 'CA-r1' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const auditRepo = new InMemoryAuditRepository();
    const createSpy = vi.spyOn(auditRepo, 'create');
    const restRedirect = vi.fn().mockResolvedValue(true);
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: failingStreamingProvider(),
        speechTurn: async () => [],
        realtimeCircuit: circuit,
        auditRepo,
        restRedirect,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-r1', 'MZ-r1'));
    await flush();
    await flush();

    // Redirect attempted with the callSid + the start-frame AccountSid.
    expect(restRedirect).toHaveBeenCalledWith({ callSid: 'CA-r1', accountSid: 'AC' });
    // Live call continues on Gather — closed 1000, not 1011.
    expect(ws.closeCode).toBe(1000);
    expect(ws.closeReason).toBe('degraded_to_gather');
    // Circuit failure still records so subsequent calls steer to Gather.
    expect(circuit.recordFailure).toHaveBeenCalledWith('deepgram_open_failed');
    // Both audits fire: session_failed then degraded_to_gather.
    const types = createSpy.mock.calls.map((c) => c[0].eventType);
    expect(types).toContain('voice.realtime.session_failed');
    expect(types).toContain('voice.realtime.degraded_to_gather');
    const degraded = createSpy.mock.calls.find(
      (c) => c[0].eventType === 'voice.realtime.degraded_to_gather',
    )![0];
    expect(degraded.tenantId).toBe('tenant-r1');
    // OBS — fired after the redirect succeeded and the WS was already
    // closed 1000 above.
    expect(recordVoiceErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: 'degraded_to_gather',
        channel: 'media_streams',
        callSid: 'CA-r1',
        tenantId: 'tenant-r1',
      }),
    );
    expect(degraded.entityId).toBe('CA-r1');
  });

  it('Deepgram open failure + redirect failure → pins today’s 1011 close', async () => {
    store.create('tenant-r2', 'telephony', { callSid: 'CA-r2' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const auditRepo = new InMemoryAuditRepository();
    const createSpy = vi.spyOn(auditRepo, 'create');
    const restRedirect = vi.fn().mockResolvedValue(false);
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: failingStreamingProvider(),
        speechTurn: async () => [],
        realtimeCircuit: circuit,
        auditRepo,
        restRedirect,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-r2', 'MZ-r2'));
    await flush();
    await flush();

    expect(restRedirect).toHaveBeenCalledTimes(1);
    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe('deepgram_open_failed');
    expect(circuit.recordFailure).toHaveBeenCalledWith('deepgram_open_failed');
    const types = createSpy.mock.calls.map((c) => c[0].eventType);
    expect(types).toContain('voice.realtime.session_failed');
    expect(types).not.toContain('voice.realtime.degraded_to_gather');
    // OBS — the degrade attempt failed, so no degraded_to_gather voice_error
    // fires either (only the successful path is instrumented).
    expect(recordVoiceErrorMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: 'degraded_to_gather' }),
    );
  });

  it('Deepgram open failure, no redirector wired → 1011 close (unchanged)', async () => {
    store.create('tenant-r3', 'telephony', { callSid: 'CA-r3' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: failingStreamingProvider(),
        speechTurn: async () => [],
        realtimeCircuit: circuit,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-r3', 'MZ-r3'));
    await flush();

    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe('deepgram_open_failed');
  });

  it('Deepgram unexpected mid-call close + redirect success → close 1000 + degraded audit', async () => {
    store.create('tenant-r4', 'telephony', { callSid: 'CA-r4' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const auditRepo = new InMemoryAuditRepository();
    const createSpy = vi.spyOn(auditRepo, 'create');
    const restRedirect = vi.fn().mockResolvedValue(true);
    const { provider, fireClose } = capturingStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        initializeSession: async () => [],
        realtimeCircuit: circuit,
        auditRepo,
        restRedirect,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-r4', 'MZ-r4'));
    await flush();

    // Session established cleanly; now Deepgram closes on its own mid-call.
    expect(ws.closed).toBe(false);
    fireClose();
    await flush();
    await flush();

    expect(restRedirect).toHaveBeenCalledWith({ callSid: 'CA-r4', accountSid: 'AC' });
    expect(ws.closeCode).toBe(1000);
    expect(ws.closeReason).toBe('degraded_to_gather');
    const types = createSpy.mock.calls.map((c) => c[0].eventType);
    expect(types).toContain('voice.realtime.degraded_to_gather');
    // WS16a — the mid-call death voted failure exactly once (a successful
    // degrade still means realtime died); the subsequent ws close is latched.
    expect(circuit.recordFailure).toHaveBeenCalledTimes(1);
    expect(circuit.recordFailure).toHaveBeenCalledWith('deepgram_unexpected_close');
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
  });

  it('Deepgram unexpected mid-call close + redirect failure → no-op (WS stays open)', async () => {
    store.create('tenant-r5', 'telephony', { callSid: 'CA-r5' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const auditRepo = new InMemoryAuditRepository();
    const createSpy = vi.spyOn(auditRepo, 'create');
    const restRedirect = vi.fn().mockResolvedValue(false);
    const { provider, fireClose } = capturingStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        initializeSession: async () => [],
        realtimeCircuit: circuit,
        auditRepo,
        restRedirect,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-r5', 'MZ-r5'));
    await flush();

    fireClose();
    await flush();
    await flush();

    expect(restRedirect).toHaveBeenCalledTimes(1);
    // Today's behavior preserved: the WS is NOT closed by the redirect path.
    expect(ws.closed).toBe(false);
    const types = createSpy.mock.calls.map((c) => c[0].eventType);
    expect(types).not.toContain('voice.realtime.degraded_to_gather');
    // WS16a — the mid-call death still voted failure once even though the
    // redirect was refused and the WS drains to `stop` in production.
    expect(circuit.recordFailure).toHaveBeenCalledTimes(1);
    expect(circuit.recordFailure).toHaveBeenCalledWith('deepgram_unexpected_close');
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
  });

  it('a deliberate language switch does NOT trigger the redirect (stale-generation close)', async () => {
    const session = store.create('tenant-ls1', 'telephony', { callSid: 'CA-ls1' });
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const restRedirect = vi.fn().mockResolvedValue(true);
    const { provider, sessions, emit, fireClose, openCount } = multiSessionStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        initialLanguageResolver: async () => 'en',
        restRedirect,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-ls1', 'MZ-ls1'));
    await flush();

    // First Spanish final → deliberate finish + reopen in es.
    emit({ type: 'final', isFinal: true, transcript: 'Hola, necesito una cita por favor', confidence: 0.9 });
    for (let i = 0; i < 8; i++) await flush();
    expect(sessions[0].finish).toHaveBeenCalled();
    expect(openCount()).toBe(2);

    // The finished OLD socket now closes (real Deepgram fires onClose on the
    // ws 'close' that follows finish()). This is NOT an unexpected failure.
    fireClose(0);
    for (let i = 0; i < 4; i++) await flush();

    expect(restRedirect).not.toHaveBeenCalled();
    expect(ws.closed).toBe(false);
  });

  it('an unexpected close AFTER a language switch DOES degrade to Gather', async () => {
    const session = store.create('tenant-ls2', 'telephony', { callSid: 'CA-ls2' });
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const auditRepo = new InMemoryAuditRepository();
    const createSpy = vi.spyOn(auditRepo, 'create');
    const restRedirect = vi.fn().mockResolvedValue(true);
    const { provider, emit, fireClose, openCount } = multiSessionStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        initialLanguageResolver: async () => 'en',
        auditRepo,
        restRedirect,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-ls2', 'MZ-ls2'));
    await flush();

    emit({ type: 'final', isFinal: true, transcript: 'Hola, necesito una cita por favor', confidence: 0.9 });
    for (let i = 0; i < 8; i++) await flush();
    expect(openCount()).toBe(2);

    // The LIVE post-switch session dies unexpectedly → degrade fires.
    fireClose(1);
    for (let i = 0; i < 4; i++) await flush();

    expect(restRedirect).toHaveBeenCalledWith({ callSid: 'CA-ls2', accountSid: 'AC' });
    expect(ws.closeCode).toBe(1000);
    expect(ws.closeReason).toBe('degraded_to_gather');
    const types = createSpy.mock.calls.map((c) => c[0].eventType);
    expect(types).toContain('voice.realtime.degraded_to_gather');
  });

  it('successful degrade SKIPS finalizeOnClose and keeps the session findable by CallSid', async () => {
    store.create('tenant-fin1', 'telephony', { callSid: 'CA-fin1' });
    const ws = new FakeWs();
    const finalizeOnClose = vi.fn();
    const restRedirect = vi.fn().mockResolvedValue(true);
    const { provider, fireClose } = capturingStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        initializeSession: async () => [],
        finalizeOnClose,
        restRedirect,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-fin1', 'MZ-fin1'));
    await flush();

    fireClose();
    await flush();
    await flush();

    expect(ws.closeCode).toBe(1000);
    // The Gather leg owns finalization — no terminal outcome stamped mid-call.
    expect(finalizeOnClose).not.toHaveBeenCalled();
    // The session is still live in the store: /voice/gather-fallback can
    // continue the SAME session.
    const found = store.findByCallSid('CA-fin1');
    expect(found).toBeDefined();
    expect(found!.ended).toBe(false);
    expect(found!.terminalOutcome).toBeUndefined();
  });

  it('failed redirect on Deepgram open failure still finalizes exactly as today', async () => {
    store.create('tenant-fin2', 'telephony', { callSid: 'CA-fin2' });
    const ws = new FakeWs();
    const finalizeOnClose = vi.fn();
    const restRedirect = vi.fn().mockResolvedValue(false);
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: failingStreamingProvider(),
        speechTurn: async () => [],
        finalizeOnClose,
        restRedirect,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-fin2', 'MZ-fin2'));
    await flush();
    await flush();

    expect(ws.closeCode).toBe(1011);
    // closeWs(1011) → ws 'close' → handleClose('ws_closed') → finalize with
    // the transport_failure mapping, exactly the pre-WS7 contract.
    expect(finalizeOnClose).toHaveBeenCalledTimes(1);
    expect(finalizeOnClose.mock.calls[0][1]).toBe('transport_failure');
  });
});

describe('WS3 mediastream resilience — disclosure/greeting bootstrap failure', () => {
  it('trips the circuit, emits voice.disclosure.init_failed, and CONTINUES the call', async () => {
    store.create('tenant-disc', 'telephony', { callSid: 'CA-disc' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const auditRepo = new InMemoryAuditRepository();
    const createSpy = vi.spyOn(auditRepo, 'create');
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: okStreamingProvider(),
        speechTurn: async () => [],
        initializeSession: async () => {
          throw new Error('disclosure ledger write failed');
        },
        realtimeCircuit: circuit,
        auditRepo,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-disc', 'MZ-disc'));
    await flush();

    // Call continues — a live customer is NOT hung up.
    expect(ws.closed).toBe(false);
    expect(circuit.recordFailure).toHaveBeenCalledWith('disclosure_init_failed');
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const event = createSpy.mock.calls[0][0];
    expect(event.eventType).toBe('voice.disclosure.init_failed');
    expect(event.tenantId).toBe('tenant-disc');
    expect(event.entityId).toBe('CA-disc');
    expect(event.metadata).toMatchObject({ reason: 'disclosure_init_failed' });
  });
});

describe('WS3/WS16a mediastream resilience — clean establishment votes success at CLOSE, not establish', () => {
  it('does NOT vote at establishment; votes success once on a clean twilio_stop', async () => {
    store.create('tenant-ok', 'telephony', { callSid: 'CA-ok' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const auditRepo = new InMemoryAuditRepository();
    const createSpy = vi.spyOn(auditRepo, 'create');
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: okStreamingProvider(),
        speechTurn: async () => [],
        initializeSession: async () => [],
        realtimeCircuit: circuit,
        auditRepo,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-ok', 'MZ-ok'));
    await flush();

    // WS16a — establishment no longer resets the circuit (the trap fix).
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
    expect(circuit.recordFailure).not.toHaveBeenCalled();

    // The caller hangs up cleanly: success is voted exactly once, at close.
    ws.inboundJson(STOP_FRAME('MZ-ok'));
    await flush();
    expect(circuit.recordSuccess).toHaveBeenCalledTimes(1);
    expect(circuit.recordFailure).not.toHaveBeenCalled();

    const resilienceAudits = createSpy.mock.calls.filter((c) =>
      ['voice.realtime.session_failed', 'voice.disclosure.init_failed'].includes(
        c[0].eventType,
      ),
    );
    expect(resilienceAudits).toHaveLength(0);
  });

  it('no initializeSession wired: still votes success only at close (twilio_stop)', async () => {
    store.create('tenant-nodisc', 'telephony', { callSid: 'CA-nodisc' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: okStreamingProvider(),
        speechTurn: async () => [],
        realtimeCircuit: circuit,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-nodisc', 'MZ-nodisc'));
    await flush();

    expect(circuit.recordSuccess).not.toHaveBeenCalled();

    ws.inboundJson(STOP_FRAME('MZ-nodisc'));
    await flush();
    expect(circuit.recordSuccess).toHaveBeenCalledTimes(1);
    expect(circuit.recordFailure).not.toHaveBeenCalled();
  });
});

describe('WS16a mediastream resilience — circuit fed by real call outcomes', () => {
  it('establish-then-die trap: two clean establishments that die mid-call trip a REAL circuit', async () => {
    const clock = new FakeClock();
    const circuit = new RealtimeHealthCircuit({ threshold: 2, ttlMs: 60_000, clock });

    for (const n of [1, 2]) {
      store.create(`tenant-trap${n}`, 'telephony', { callSid: `CA-trap${n}` });
      const ws = new FakeWs();
      const { provider, fireClose } = capturingStreamingProvider();
      const adapter = new TwilioMediaStreamAdapter(
        {
          store,
          streamingProvider: provider,
          speechTurn: async () => [],
          initializeSession: async () => [],
          realtimeCircuit: circuit,
          // No restRedirect: the leg has no degrade, so the ONLY vote is the
          // mid-call Deepgram close (WS stays open, no handleClose success).
        },
        ws,
      );
      adapter.start();
      ws.inboundJson(START_FRAME(`CA-trap${n}`, `MZ-trap${n}`));
      await flush();

      // Establishment did NOT reset the breaker — the whole point of the fix.
      expect(circuit.isOpen()).toBe(false);

      // Established cleanly, then Deepgram dies mid-call.
      fireClose();
      await flush();
    }

    // Two establish-then-die legs → the breaker is finally OPEN.
    expect(circuit.isOpen()).toBe(true);
  });

  it('triple-signal leg (deepgram close + accepted degrade + ws close) votes exactly ONE failure', async () => {
    store.create('tenant-triple', 'telephony', { callSid: 'CA-triple' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const restRedirect = vi.fn().mockResolvedValue(true);
    const { provider, fireClose } = capturingStreamingProvider();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        initializeSession: async () => [],
        realtimeCircuit: circuit,
        restRedirect,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-triple', 'MZ-triple'));
    await flush();

    // Deepgram close → failure latched → degrade accepted → closeWs(1000) →
    // ws 'close' → handleClose('ws_closed') (all suppressed by the latch).
    fireClose();
    await flush();
    await flush();

    expect(circuit.recordFailure).toHaveBeenCalledTimes(1);
    expect(circuit.recordFailure).toHaveBeenCalledWith('deepgram_unexpected_close');
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
  });

  it('disclosure_init_failed then a clean twilio_stop → one failure, no success (latch keeps the failure vote)', async () => {
    store.create('tenant-disc-stop', 'telephony', { callSid: 'CA-disc-stop' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: okStreamingProvider(),
        speechTurn: async () => [],
        initializeSession: async () => {
          throw new Error('disclosure ledger write failed');
        },
        realtimeCircuit: circuit,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-disc-stop', 'MZ-disc-stop'));
    await flush();

    expect(circuit.recordFailure).toHaveBeenCalledTimes(1);
    expect(circuit.recordFailure).toHaveBeenCalledWith('disclosure_init_failed');

    // The call continued; caller later hangs up cleanly. The clean stop must
    // NOT overwrite the establishment failure vote (that would revive the trap).
    ws.inboundJson(STOP_FRAME('MZ-disc-stop'));
    await flush();
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
    expect(circuit.recordFailure).toHaveBeenCalledTimes(1);
  });

  // ws_error + ws_closed are the deterministically drivable transport-failure
  // closes; slow_consumer and queue_overflow_terminal share the identical
  // mapCloseReasonToFinalize → transport_failure → recordFailure path (pinned
  // at unit level in mapCloseReasonToFinalize's classification), so exercising
  // these two proves the established-transport-failure vote.
  it('established → ws_error / ws_closed transport-failure close → one failure each', async () => {
    const cases: Array<{ trigger: (ws: FakeWs) => void; label: string }> = [
      { label: 'ws_error', trigger: (ws) => ws.fire('error', new Error('boom')) },
      { label: 'ws_closed', trigger: (ws) => ws.fire('close') },
    ];
    for (const [i, c] of cases.entries()) {
      store.create(`tenant-tf${i}`, 'telephony', { callSid: `CA-tf${i}` });
      const ws = new FakeWs();
      const circuit = makeCircuit();
      const adapter = new TwilioMediaStreamAdapter(
        {
          store,
          streamingProvider: okStreamingProvider(),
          speechTurn: async () => [],
          initializeSession: async () => [],
          realtimeCircuit: circuit,
        },
        ws,
      );
      adapter.start();
      ws.inboundJson(START_FRAME(`CA-tf${i}`, `MZ-tf${i}`));
      await flush();
      expect(circuit.recordFailure).not.toHaveBeenCalled();

      c.trigger(ws);
      await flush();
      expect(circuit.recordFailure, c.label).toHaveBeenCalledTimes(1);
      expect(circuit.recordSuccess, c.label).not.toHaveBeenCalled();
    }
  });

  it('deepgram_reopen_failed → one failure vote + finalize reason transport_failure', async () => {
    const session = store.create('tenant-reopen', 'telephony', { callSid: 'CA-reopen' });
    session.supportedLanguages = ['en', 'es'];
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const finalizeOnClose = vi.fn();

    // Open #1 succeeds; every reopen (target + same-language recovery) rejects.
    const onEvents: StreamingTranscriptCallback[] = [];
    let openCount = 0;
    const provider: StreamingTranscriptionProvider = {
      openSession: vi.fn((onEvent: StreamingTranscriptCallback) => {
        openCount += 1;
        if (openCount === 1) {
          onEvents.push(onEvent);
          return Promise.resolve({ send: vi.fn(), finish: vi.fn(), destroy: vi.fn() } as unknown as StreamingSession);
        }
        return Promise.reject(new Error('reopen 503'));
      }),
    };

    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        speechTurn: async () => [],
        initialLanguageResolver: async () => 'en',
        realtimeCircuit: circuit,
        finalizeOnClose,
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-reopen', 'MZ-reopen'));
    await flush();

    // First Spanish final triggers a language switch → reopen fails → recovery
    // reopen fails → handleClose('deepgram_reopen_failed').
    onEvents[0]?.({ type: 'final', isFinal: true, transcript: 'Hola, necesito una cita por favor', confidence: 0.9 });
    for (let i = 0; i < 8; i++) await flush();

    expect(circuit.recordFailure).toHaveBeenCalledTimes(1);
    expect(circuit.recordFailure).toHaveBeenCalledWith('deepgram_reopen_failed');
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
    // The mapCloseReasonToFinalize fix: classified transport_failure, not the
    // caller_hangup default.
    expect(finalizeOnClose).toHaveBeenCalledTimes(1);
    expect(finalizeOnClose.mock.calls[0][1]).toBe('transport_failure');
  });
});

describe('WS16a mediastream resilience — pre-establishment closes never vote', () => {
  it('unknown CallSid → zero circuit calls', async () => {
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: okStreamingProvider(), speechTurn: async () => [], realtimeCircuit: circuit },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-nope', 'MZ-nope'));
    await flush();

    expect(ws.closeCode).toBe(1008);
    expect(circuit.recordFailure).not.toHaveBeenCalled();
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
  });

  it('tenant mismatch → zero circuit calls', async () => {
    store.create('tenant-real', 'telephony', { callSid: 'CA-mismatch' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const adapter = new TwilioMediaStreamAdapter(
      { store, streamingProvider: okStreamingProvider(), speechTurn: async () => [], realtimeCircuit: circuit },
      ws,
    );
    adapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: 'MZ-mismatch',
      start: {
        callSid: 'CA-mismatch',
        accountSid: 'AC',
        streamSid: 'MZ-mismatch',
        tracks: ['inbound'],
        customParameters: { tenantId: 'tenant-evil' },
      },
    });
    await flush();

    expect(ws.closeCode).toBe(1008);
    expect(circuit.recordFailure).not.toHaveBeenCalled();
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
  });

  it('connection cap exceeded → zero circuit calls', async () => {
    store.create('tenant-cap', 'telephony', { callSid: 'CA-cap' });
    const ws = new FakeWs();
    const circuit = makeCircuit();
    const adapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: okStreamingProvider(),
        speechTurn: async () => [],
        realtimeCircuit: circuit,
        connectionRegistry: new InMemoryConnectionRegistry({ perTenantMax: 0 }),
      },
      ws,
    );
    adapter.start();
    ws.inboundJson(START_FRAME('CA-cap', 'MZ-cap'));
    await flush();

    expect(ws.closeCode).toBe(1013);
    expect(circuit.recordFailure).not.toHaveBeenCalled();
    expect(circuit.recordSuccess).not.toHaveBeenCalled();
  });
});
