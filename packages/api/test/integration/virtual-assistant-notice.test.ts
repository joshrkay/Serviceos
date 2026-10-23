/**
 * PRIV-4 at REAL POSTGRES — the virtual-assistant notice is spoken on every
 * phone call and ledgered in `audit_events` only once the caller heard it.
 *
 * Drives the production wiring (`TwilioGatherAdapter` for Gather, plus
 * `TwilioMediaStreamAdapter` wired the way app.ts wires it:
 * `initializeSession` → `initializeStreamSession`, `commitRecordingConsent` →
 * `commitRecordingConsent`) with the real `PgAuditRepository` and
 * `PgConsentEventRepository`, under the RLS runtime role, and asserts from
 * Postgres rows:
 *
 *   - Gather: the first <Say> carries the notice before <Start><Record>, and
 *     exactly one `virtual_assistant_notice.played` row lands — for a
 *     California caller ID and for a blocked one alike;
 *   - Media Streams: the first synthesized turn carries the notice and the row
 *     lands once that turn played; a greeting that fails closed (non-PCM TTS)
 *     writes no row;
 *   - the row is tenant-scoped: another tenant's read of the session sees
 *     nothing.
 *
 * Only the WS, STT and TTS are fakes; the thing under test is the greeting
 * text and the Postgres write.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import {
  TwilioMediaStreamAdapter,
  type WsLike,
} from '../../src/telephony/media-streams/mediastream-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgConsentEventRepository } from '../../src/compliance/consent-events';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
} from '../../src/voice/transcription-providers';

const NOTICE = "Just so you know, I'm a virtual assistant, not a live person.";
const NOTICE_XML = 'Just so you know, I&apos;m a virtual assistant, not a live person.';
const NOTICE_EVENT = 'virtual_assistant_notice.played';

class FakeWs implements WsLike {
  closed = false;
  closeReason: string | undefined;
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(_code?: number, reason?: string): void {
    this.closed = true;
    this.closeReason = reason;
    this.fire('close');
  }
  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.listeners[event] ??= []).push(listener);
  }
  private fire(event: string, ...args: unknown[]): void {
    for (const l of this.listeners[event] ?? []) l(...args);
  }
  inboundJson(obj: unknown): void {
    this.fire('message', JSON.stringify(obj));
  }
}

function makeStreamingProvider(): StreamingTranscriptionProvider {
  const session = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
  return {
    openSession: vi.fn((_onEvent: StreamingTranscriptCallback) =>
      Promise.resolve(session as unknown as StreamingSession),
    ),
  };
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

async function waitForNoticeRows(
  auditRepo: PgAuditRepository,
  tenantId: string,
  sessionId: string,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await auditRepo.findByEntity(tenantId, 'voice_session', sessionId)).filter(
      (e) => e.eventType === NOTICE_EVENT,
    );
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await sleep(10);
  }
}

describe('Postgres integration — virtual-assistant notice on every phone call (PRIV-4)', () => {
  let pool: Pool;
  let auditRepo: PgAuditRepository;
  let consentRepo: PgConsentEventRepository;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    consentRepo = new PgConsentEventRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function makeTwilioAdapter(store: VoiceSessionStore) {
    return new TwilioGatherAdapter({
      store,
      gateway: { complete: vi.fn() } as never,
      pool,
      consentEvents: consentRepo,
      auditRepo,
      systemActorId: 'system:inbound-call',
      businessName: 'Test Co',
      publicBaseUrl: 'https://example.com',
      recordingCallbackPath: '/api/telephony/recording',
    });
  }

  for (const [label, from] of [
    ['a California caller ID', '+14155550123'],
    ['a blocked caller ID', ''],
  ] as const) {
    it(`Gather, ${label}: the first <Say> carries the notice before recording starts, and one row lands`, async () => {
      const store = new VoiceSessionStore({ startInterval: false });
      const adapter = makeTwilioAdapter(store);
      const callSid = `CA-int-notice-${from || 'blocked'}`;
      const xml = await adapter.handleInbound({
        callSid,
        from,
        to: '+15125550999',
        tenantId: tenantA.tenantId,
      });
      const firstSayEnd = xml.indexOf('</Say>');
      expect(xml.indexOf(NOTICE_XML)).toBeGreaterThan(-1);
      expect(xml.indexOf(NOTICE_XML)).toBeLessThan(firstSayEnd);
      expect(firstSayEnd).toBeLessThan(xml.indexOf('<Start><Record'));

      const sessionId = store.findByCallSid(callSid)!.id;
      const rows = await waitForNoticeRows(auditRepo, tenantA.tenantId, sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: tenantA.tenantId,
        eventType: NOTICE_EVENT,
        entityType: 'voice_session',
        entityId: sessionId,
        correlationId: sessionId,
        actorRole: 'system',
        actorId: 'system:inbound-call',
      });
      expect(rows[0].metadata).toMatchObject({ text: NOTICE, wording: 'default', language: 'en' });

      // Tenant-scoped: tenant B sees nothing for tenant A's session.
      expect(await auditRepo.findByEntity(tenantB.tenantId, 'voice_session', sessionId)).toHaveLength(0);
    });
  }

  async function streamCall(callSid: string, phone: string, tts: { synthesize: ReturnType<typeof vi.fn> }) {
    const store = new VoiceSessionStore({ startInterval: false });
    const twilioAdapter = makeTwilioAdapter(store);
    await twilioAdapter.handleInboundForStream({ callSid, from: phone, tenantId: tenantA.tenantId });
    const ws = new FakeWs();
    const mediaAdapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: makeStreamingProvider(),
        ttsProvider: tts,
        speechTurn: async () => [],
        initializeSession: ({ callSid: sid, tenantId: tid }) =>
          twilioAdapter.initializeStreamSession({ callSid: sid, tenantId: tid }),
        commitRecordingConsent: ({ callSid: sid }) =>
          twilioAdapter.commitRecordingConsent({ callSid: sid }),
      },
      ws,
    );
    mediaAdapter.start();
    ws.inboundJson({
      event: 'start',
      streamSid: `MZ-${callSid}`,
      start: { callSid, accountSid: 'AC', streamSid: `MZ-${callSid}`, tracks: ['inbound'] },
    });
    return { ws, sessionId: store.findByCallSid(callSid)!.id };
  }

  it('Media Streams: the first synthesized turn carries the notice, and the row lands once it played', async () => {
    const tts = {
      synthesize: vi.fn(async () => ({ audio: Buffer.alloc(640), contentType: 'audio/pcm', provider: 'test' })),
    };
    const { sessionId } = await streamCall('CA-int-notice-stream', '+14155550124', tts);
    const rows = await waitForNoticeRows(auditRepo, tenantA.tenantId, sessionId);
    expect(rows).toHaveLength(1);
    const firstText = (tts.synthesize.mock.calls[0]?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(firstText).toContain(NOTICE);
  });

  it('Media Streams: a greeting that fails closed (non-PCM TTS) writes no row', async () => {
    const tts = {
      synthesize: vi.fn(async () => ({ audio: Buffer.from('ID3-fake-mp3'), contentType: 'audio/mpeg', provider: 'test' })),
    };
    const { ws, sessionId } = await streamCall('CA-int-notice-failclosed', '+14155550125', tts);
    const deadline = Date.now() + 2000;
    while (!ws.closed && Date.now() < deadline) await sleep(10);
    expect(ws.closeReason).toBe('disclosure_init_failed');
    // Precondition: the greeting that failed closed DID carry the notice, so
    // the missing row is the fail-closed suppression, not an unwired notice.
    const attempted = (tts.synthesize.mock.calls[0]?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(attempted).toContain(NOTICE);
    const rows = (await auditRepo.findByEntity(tenantA.tenantId, 'voice_session', sessionId)).filter(
      (e) => e.eventType === NOTICE_EVENT,
    );
    expect(rows).toHaveLength(0);
  });
});
