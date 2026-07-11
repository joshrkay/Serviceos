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

describe('WS3 mediastream resilience — clean establishment', () => {
  it('records circuit success once disclosure init succeeds; no failure, no resilience audit', async () => {
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

    expect(circuit.recordSuccess).toHaveBeenCalledTimes(1);
    expect(circuit.recordFailure).not.toHaveBeenCalled();
    const resilienceAudits = createSpy.mock.calls.filter((c) =>
      ['voice.realtime.session_failed', 'voice.disclosure.init_failed'].includes(
        c[0].eventType,
      ),
    );
    expect(resilienceAudits).toHaveLength(0);
  });

  it('records circuit success after Deepgram open when no initializeSession is wired', async () => {
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

    expect(circuit.recordSuccess).toHaveBeenCalledTimes(1);
    expect(circuit.recordFailure).not.toHaveBeenCalled();
  });
});
