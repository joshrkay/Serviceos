/**
 * Recording-consent ordering at REAL POSTGRES (#1014 row 2.2, G3).
 *
 * The mock-based ordering proof (all three transport paths, hand-rolled
 * fakes, no DB) now lives at
 * `test/telephony/media-streams/conversation-consent-ordering.test.ts` — it
 * was moved out of `test/integration/` because it opened no pool (one of the
 * three NO-DB baseline files the map's G3 check named).
 *
 * This file drives the REAL production wiring — `TwilioGatherAdapter` +
 * `TwilioMediaStreamAdapter` wired exactly as `app.ts` wires them
 * (`initializeSession` → `twilioAdapter.initializeStreamSession`,
 * `commitRecordingConsent` → `twilioAdapter.commitRecordingConsent`), backed
 * by the real `PgConsentEventRepository` against the real `consent_events`
 * table (migration 168, RLS-enforced) — and asserts the ordering directly
 * from Postgres rows, not application state:
 *
 *   - no consent_events row exists while the disclosure is still enqueued
 *     but not yet played;
 *   - exactly one row lands, `kind='recording' state='implicit'`, once the
 *     caller has actually heard the notice (Twilio ACKs the disclosure
 *     turn's completion mark);
 *   - a disclosure that fails closed (non-PCM TTS → DISCLOSURE_INIT_FAILED)
 *     never writes a row, at real Postgres;
 *   - T1 — a consent row ledgered for tenant B against a phone number never
 *     satisfies tenant A's gate for a call from that same number (RLS +
 *     app-level tenant scoping on `consent_events`).
 *
 * Audit leg: production has no `audit_events` row for the *grant* of implicit
 * recording consent — only the caller-initiated revocation
 * (`recording_consent.revoked`, twilio-adapter.ts:1849) is audited. The
 * consent_events row IS the append-only audit trail for the grant
 * (consent-events.ts's own docstring: "Rows are never updated or deleted —
 * the ledger IS the audit trail"). Adding an audit_events emission on the
 * grant path would be a product-code change, out of scope for this
 * test-only lane (see PR body, "not done / judgment calls").
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
import type {
  StreamingSession,
  StreamingTranscriptionProvider,
  StreamingTranscriptCallback,
} from '../../src/voice/transcription-providers';

// ─── Minimal fakes for the non-Postgres parts of the transport (WS + STT +
//     TTS) — the thing under test here is the Postgres write, not the audio
//     protocol, which the unit-lane sibling file already covers exhaustively.
class FakeWs implements WsLike {
  closed = false;
  closeReason: string | undefined;
  sent: Array<Record<string, unknown>> = [];
  private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
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

function makeStreamingProvider(): {
  provider: StreamingTranscriptionProvider;
  session: StreamingSession & { send: ReturnType<typeof vi.fn> };
} {
  const session = { send: vi.fn(), finish: vi.fn(), destroy: vi.fn() };
  const provider: StreamingTranscriptionProvider = {
    openSession: vi.fn((_onEvent: StreamingTranscriptCallback) =>
      Promise.resolve(session as unknown as StreamingSession),
    ),
  };
  return { provider, session };
}

const PLAYABLE_TTS = {
  synthesize: vi.fn(async () => ({
    audio: Buffer.alloc(640),
    contentType: 'audio/pcm',
    provider: 'test',
  })),
};

/** Non-PCM: the pipeline refuses to stream it — disclosure fails closed. */
const UNPLAYABLE_TTS = {
  synthesize: vi.fn(async () => ({
    audio: Buffer.from('ID3-fake-mp3'),
    contentType: 'audio/mpeg',
    provider: 'test',
  })),
};

const flush = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function silenceArmMarkName(ws: FakeWs): string | undefined {
  const frame = ws.sent.find(
    (f) =>
      f.event === 'mark' &&
      typeof (f.mark as { name?: string } | undefined)?.name === 'string' &&
      (f.mark as { name: string }).name.startsWith('silence-arm-'),
  );
  return (frame?.mark as { name: string } | undefined)?.name;
}

/** Poll for the disclosure turn's completion mark — real Postgres round-trips
 * inside the bootstrap chain (identifyCaller) don't always settle within a
 * fixed number of setImmediate ticks. */
async function waitForSilenceArmMark(ws: FakeWs, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const name = silenceArmMarkName(ws);
    if (name) return name;
    if (Date.now() > deadline) throw new Error('timed out waiting for silence-arm mark');
    await sleep(10);
  }
}

/**
 * Poll for the consent_events row rather than reading once. Review finding
 * (xhawk-ai, PR #1043): `TwilioMediaStreamAdapter` commits recording consent
 * via `void this.deps.commitRecordingConsent(...)` (mediastream-adapter.ts)
 * — fire-and-forget, not awaited by the caller that enqueues the completion
 * mark — so an immediate read right after the mark appears can intermittently
 * see zero rows under normal Postgres scheduling even when production is
 * correct. Polling with a bounded timeout removes that flake while still
 * failing loudly (never silently) if the row genuinely never lands.
 */
async function waitForConsentRow(
  consentRepo: PgConsentEventRepository,
  tenantId: string,
  phone: string,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await consentRepo.listByPhone(tenantId, phone);
    if (rows.length > 0) return rows;
    if (Date.now() > deadline) return rows; // let the assertion report the (empty) mismatch
    await sleep(10);
  }
}

const startFrame = (callSid: string, streamSid: string) => ({
  event: 'start' as const,
  streamSid,
  start: { callSid, accountSid: 'AC', streamSid, tracks: ['inbound'] },
});

const mediaFrame = { event: 'media' as const, media: { payload: 'AAAA' } };

describe('Postgres integration — recording-consent ledger ordering (RV-130)', () => {
  let pool: Pool;
  let consentRepo: PgConsentEventRepository;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    consentRepo = new PgConsentEventRepository(pool);
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /**
   * Wires the two adapters exactly as `app.ts` wires the production Media
   * Streams path (see app.ts:4399-4407): `initializeSession` and
   * `commitRecordingConsent` both delegate to the SAME `TwilioGatherAdapter`
   * instance, which carries the real `consentEvents` repo. The webhook-time
   * session establishment (`handleInboundForStream`) is the same public
   * method Twilio's POST /voice route calls — it captures the caller's phone
   * onto the session before the WS ever connects, exactly as production does.
   */
  async function establishCall(
    tenantId: string,
    callSid: string,
    phone: string,
    ttsProvider: { synthesize: ReturnType<typeof vi.fn> },
  ) {
    const store = new VoiceSessionStore({ startInterval: false });
    const twilioAdapter = new TwilioGatherAdapter({
      store,
      gateway: { complete: vi.fn() } as never,
      pool,
      consentEvents: consentRepo,
      businessName: 'Test Co',
    });
    await twilioAdapter.handleInboundForStream({ callSid, from: phone, tenantId });

    const ws = new FakeWs();
    const { provider, session } = makeStreamingProvider();
    const mediaAdapter = new TwilioMediaStreamAdapter(
      {
        store,
        streamingProvider: provider,
        ttsProvider,
        speechTurn: async () => [],
        initializeSession: ({ callSid: sid, tenantId: tid }) =>
          twilioAdapter.initializeStreamSession({ callSid: sid, tenantId: tid }),
        commitRecordingConsent: ({ callSid: sid }) =>
          twilioAdapter.commitRecordingConsent({ callSid: sid }),
      },
      ws,
    );
    return { ws, session, mediaAdapter };
  }

  it('writes the consent_events row at the disclosure-PLAYED point — strictly before any caller audio is captured', async () => {
    const phone = '+15125550111';
    const callSid = 'CA-int-consent-ok';
    const { ws, session, mediaAdapter } = await establishCall(
      tenantA.tenantId,
      callSid,
      phone,
      PLAYABLE_TTS,
    );
    mediaAdapter.start();

    ws.inboundJson(startFrame(callSid, 'MZ-int-ok'));
    // Wait for the disclosure turn's completion mark to be enqueued — this is
    // the transport's point of evidence that the disclosure was synthesized
    // and streamed out, which is also where commitRecordingConsent fires.
    const markName = await waitForSilenceArmMark(ws);

    // The disclosure has been synthesized and streamed out (the transport's
    // point of evidence) — the ledger row is committed to real Postgres here,
    // BEFORE capture has opened. Proven two ways at once: the DB row exists,
    // and caller audio arriving right now is still dropped (not yet armed).
    const rowsAtDisclosurePlayed = await waitForConsentRow(consentRepo, tenantA.tenantId, phone);
    expect(rowsAtDisclosurePlayed).toHaveLength(1);
    expect(rowsAtDisclosurePlayed[0]).toMatchObject({
      tenantId: tenantA.tenantId,
      kind: 'recording',
      state: 'implicit',
      source: 'voice',
    });

    ws.inboundJson(mediaFrame);
    await flush();
    expect(session.send).not.toHaveBeenCalled();

    // Only once Twilio ACKs the disclosure turn's completion mark does
    // capture open — audio now flows, strictly AFTER the ledger row above.
    ws.inboundJson({ event: 'mark', streamSid: 'MZ-int-ok', mark: { name: markName } });
    await flush();
    ws.inboundJson(mediaFrame);
    await flush();
    expect(session.send).toHaveBeenCalledTimes(1);

    // The row is not re-committed by the mark ACK / capture-open step.
    const rowsAfterCapture = await consentRepo.listByPhone(tenantA.tenantId, phone);
    expect(rowsAfterCapture).toHaveLength(1);
  });

  it('a disclosure that fails closed (non-PCM TTS) never writes a consent_events row', async () => {
    const phone = '+15125550112';
    const callSid = 'CA-int-consent-failclosed';
    const { ws, mediaAdapter } = await establishCall(
      tenantA.tenantId,
      callSid,
      phone,
      UNPLAYABLE_TTS,
    );
    mediaAdapter.start();

    ws.inboundJson(startFrame(callSid, 'MZ-int-fail'));
    await flush();
    await flush();
    await sleep(50);

    expect(ws.closed).toBe(true);
    expect(ws.closeReason).toBe('disclosure_init_failed');

    const rows = await consentRepo.listByPhone(tenantA.tenantId, phone);
    expect(rows).toHaveLength(0);
  });

  it('T1: a consent row ledgered for tenant B never satisfies tenant A\'s gate for the same phone number', async () => {
    const sharedPhone = '+15125550199';

    // Tenant B's caller hears the disclosure and ledgers implicit consent.
    const b = await establishCall(tenantB.tenantId, 'CA-int-consent-tenantb', sharedPhone, PLAYABLE_TTS);
    b.mediaAdapter.start();
    b.ws.inboundJson(startFrame('CA-int-consent-tenantb', 'MZ-int-tb'));
    const bMark = await waitForSilenceArmMark(b.ws);
    b.ws.inboundJson({ event: 'mark', streamSid: 'MZ-int-tb', mark: { name: bMark } });
    await flush();
    await flush();

    const tenantBRows = await waitForConsentRow(consentRepo, tenantB.tenantId, sharedPhone);
    expect(tenantBRows).toHaveLength(1);

    // Tenant A has never seen this caller. Its own gate — a listByPhone
    // scoped to tenant A's RLS context — must NOT see tenant B's row.
    const tenantARows = await consentRepo.listByPhone(tenantA.tenantId, sharedPhone);
    expect(tenantARows).toHaveLength(0);
  });
});
