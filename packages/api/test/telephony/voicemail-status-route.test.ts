/**
 * U9 — voicemail-status callback tests (transcription leg + idempotency).
 *
 * Executed-effect assertions (P-44): every case checks the persisted lead
 * rows, the FakePool's voice_recordings/files rows, the S3 upload calls,
 * and the onVoicemailPersisted hand-off — not just the HTTP status.
 *
 * Covers:
 *   - signature enforcement (public Twilio callback)
 *   - happy path: authenticated Twilio fetch → S3 PUT (voicemail-specific
 *     key) → idempotent voice_recordings insert → transcription hand-off
 *     carrying the caller phone from the signed callback URL
 *   - replay idempotency for BOTH legs: a second delivery of the same
 *     RecordingSid creates no second lead and no second recording row
 *   - CROSS-LEG collision (review fix): one call producing BOTH a live-leg
 *     recording (/recording) AND a voicemail (/voicemail-status) yields
 *     TWO voice_recordings rows in either arrival order — the voicemail
 *     pipeline no longer silently no-ops when /recording lands first
 *   - at-least-once transcription (review fix): a transient failure
 *     answers 500 (Twilio retries) and the retry completes the pipeline
 *     without duplicating the receipt-guarded lead; same for a failing
 *     enqueue hook (errors now propagate)
 *   - after-hours case: no in-process session — tenant resolves via the
 *     To-number fallback minted onto the callback URL
 *   - unknown-caller voicemail still gets the lead + transcription enqueue
 *     (the owner gate lives at transcript completion, not here)
 *   - legacy shape (no receipt store / storage) keeps the historical
 *     failure-soft 200 and notify-only behavior
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import {
  buildVoicemailStorageKey,
  type VoicemailPersistedEvent,
} from '../../src/telephony/voicemail-status-route';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryWebhookEventRepository } from '../../src/webhooks/in-memory-webhook-event';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type {
  StorageProvider,
  ObjectMetadata,
} from '../../src/files/file-service';

const AUTH_TOKEN = 'test-tw-token-voicemail';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TWILIO_ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TWILIO_AUTH_TOKEN = 'super-secret-twilio-token';
const STORAGE_BUCKET = 'serviceos-recordings';
const OWNER_PHONE = '+15125550100';
const BUSINESS_PHONE = '+15125550199';

function makeGateway(): LLMGateway {
  const response: LLMResponse = {
    content: '{"intentType":"unknown","confidence":0,"reasoning":"x"}',
    model: 'mock',
    provider: 'mock',
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  };
  return { complete: vi.fn().mockResolvedValue(response) } as unknown as LLMGateway;
}

class FakeStorageProvider implements StorageProvider {
  public uploadKeys: string[] = [];
  public lastUploadBucket: string | null = null;
  public lastUploadContentType: string | null = null;

  async generateUploadUrl(bucket: string, key: string, contentType: string): Promise<string> {
    this.lastUploadBucket = bucket;
    this.uploadKeys.push(key);
    this.lastUploadContentType = contentType;
    return `https://s3.fake/${bucket}/${key}?sig=presigned-put`;
  }
  async generateDownloadUrl(bucket: string, key: string): Promise<string> {
    return `https://s3.fake/${bucket}/${key}?sig=presigned-get`;
  }
  async getObjectMetadata(): Promise<ObjectMetadata | null> {
    return null;
  }
  async getObject(): Promise<Buffer | null> {
    return null;
  }
  async putObject(): Promise<void> {
    return;
  }
  async deleteObject(): Promise<void> {
    return;
  }
}

interface VoiceRecordingRow {
  id: string;
  tenant_id: string;
  call_sid: string;
  source: string;
  recording_url: string;
  duration_seconds: number;
  created_by: string;
  status: string;
}

/**
 * Minimal pg.Pool stub mirroring recording-webhook.test.ts — just enough
 * surface for `recordInboundCall` (connect/query/release) including the
 * SELECT-by-(tenant, call_sid, recording_url) idempotency probe: the
 * per-RECORDING identity (review fix), so the live-leg recording and the
 * voicemail of one call are two rows while replays still dedupe.
 */
class FakePool {
  public voiceRows: VoiceRecordingRow[] = [];
  public fileRows: Array<Record<string, unknown>> = [];

  async connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: () => void;
  }> {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (/SELECT id FROM voice_recordings/i.test(sql)) {
          const tenantId = params[0] as string;
          const callSid = params[1] as string;
          const recordingUrl = params[2] as string;
          const match = this.voiceRows.find(
            (r) =>
              r.tenant_id === tenantId &&
              r.call_sid === callSid &&
              r.source === 'inbound_call' &&
              r.recording_url === recordingUrl,
          );
          return { rows: match ? [{ id: match.id }] : [] };
        }
        if (/INSERT INTO files/i.test(sql)) {
          this.fileRows.push({
            id: params[0],
            tenant_id: params[1],
            filename: params[2],
            s3_bucket: params[5],
            s3_key: params[6],
          });
          return { rows: [] };
        }
        if (/INSERT INTO voice_recordings/i.test(sql)) {
          this.voiceRows.push({
            id: params[0] as string,
            tenant_id: params[1] as string,
            call_sid: params[7] as string,
            source: 'inbound_call',
            recording_url: params[8] as string,
            duration_seconds: params[3] as number,
            created_by: params[4] as string,
            status: 'completed',
          });
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {
        // no-op
      },
    };
  }
}

interface HarnessOptions {
  /** Pre-create an in-process session for this CallSid. */
  sessionCallSid?: string;
  fetchRecording?: (url: string, sid: string, token: string) => Promise<Buffer>;
  uploadObject?: (url: string, bytes: Buffer, contentType: string) => Promise<void>;
  onVoicemailPersisted?: (event: VoicemailPersistedEvent) => Promise<void> | void;
  /** Omit the receipt store to exercise the legacy (non-idempotent) shape. */
  withReceiptStore?: boolean;
  /** Omit storage/creds to exercise the notify-only fallback. */
  withTranscriptionLeg?: boolean;
  /** Tenant fallback result for session-less callbacks. */
  resolveTenantId?: () => string | undefined;
}

function buildHarness(opts: HarnessOptions = {}) {
  const store = new VoiceSessionStore();
  const storage = new FakeStorageProvider();
  const pool = new FakePool();
  const leadRepo = new InMemoryLeadRepository();
  const auditRepo = new InMemoryAuditRepository();
  const webhookEventRepo = new InMemoryWebhookEventRepository();
  const withReceiptStore = opts.withReceiptStore ?? true;
  const withTranscriptionLeg = opts.withTranscriptionLeg ?? true;

  let session;
  if (opts.sessionCallSid) {
    session = store.create(TENANT_ID, 'telephony', { callSid: opts.sessionCallSid });
  }

  const adapter = new TwilioGatherAdapter({
    store,
    gateway: makeGateway(),
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
  });

  const fetchRecording =
    opts.fetchRecording ?? vi.fn(async () => Buffer.from('ID3FAKEVOICEMAIL'));
  const uploadObject = opts.uploadObject ?? vi.fn(async () => undefined);
  const persistedEvents: VoicemailPersistedEvent[] = [];
  const onVoicemailPersisted =
    opts.onVoicemailPersisted ??
    (async (event: VoicemailPersistedEvent) => {
      persistedEvents.push(event);
    });

  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: opts.resolveTenantId ?? (() => TENANT_ID),
      pool: pool as unknown as import('pg').Pool,
      leadRepo,
      auditRepo,
      recording: {
        store,
        pool: pool as unknown as import('pg').Pool,
        storage,
        storageBucket: STORAGE_BUCKET,
        ...(withTranscriptionLeg
          ? {
              twilioAccountSid: TWILIO_ACCOUNT_SID,
              twilioAuthToken: TWILIO_AUTH_TOKEN,
            }
          : {}),
        // Stubs for the /recording (live-leg) webhook so the cross-leg
        // collision tests can fire both callbacks for one call.
        options: {
          fetchRecording: (async () => Buffer.from('ID3FAKECALLLEG')) as never,
          uploadObject: (async () => undefined) as never,
        },
      },
      voicemail: {
        ...(withReceiptStore ? { webhookEventRepo } : {}),
        options: {
          fetchRecording: fetchRecording as never,
          uploadObject: uploadObject as never,
          onVoicemailPersisted,
        },
      },
    }),
  );

  return {
    app,
    store,
    storage,
    pool,
    leadRepo,
    auditRepo,
    webhookEventRepo,
    session,
    fetchRecording,
    uploadObject,
    persistedEvents,
  };
}

/**
 * Sign + POST a voicemail-status callback. `query` mirrors the params the
 * TwiML minted onto the callback URL (Twilio signs the FULL URL including
 * the query string, so the signature must be computed over it too).
 */
function signedVoicemailRequest(
  app: express.Application,
  params: Record<string, string>,
  query = '',
) {
  const path = `/api/telephony/voicemail-status${query}`;
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post(path)
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
}

/** Signed POST to the live-leg /recording webhook (cross-leg tests). */
function signedRecordingRequest(
  app: express.Application,
  params: Record<string, string>,
) {
  const path = '/api/telephony/recording';
  const url = `${PUBLIC_BASE_URL}${path}`;
  const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  return request(app)
    .post(path)
    .set('X-Twilio-Signature', sig)
    .type('form')
    .send(params);
}

const FINAL_PARAMS = {
  CallSid: 'CA-vm-1',
  RecordingSid: 'RE-vm-1',
  RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-vm-1',
  RecordingDuration: '31',
  RecordingStatus: 'completed',
};
const CALLER_QUERY = `?From=${encodeURIComponent(OWNER_PHONE)}&To=${encodeURIComponent(BUSINESS_PHONE)}`;

describe('U9 voicemail-status route', () => {
  it('rejects unsigned requests with 403 (no lead, no recording, no enqueue)', async () => {
    const h = buildHarness({ sessionCallSid: 'CA-vm-1' });
    const res = await request(h.app)
      .post('/api/telephony/voicemail-status')
      .type('form')
      .send(FINAL_PARAMS);
    expect(res.status).toBe(403);
    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(0);
    expect(h.pool.voiceRows).toHaveLength(0);
    expect(h.persistedEvents).toHaveLength(0);
  });

  it('happy path: lead + authenticated fetch + S3 PUT + recording row + transcription hand-off', async () => {
    const h = buildHarness({ sessionCallSid: 'CA-vm-1' });
    const res = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(res.status).toBe(200);

    // Lead leg — caller phone came from the signed callback URL query.
    const leads = await h.leadRepo.findByTenant(TENANT_ID);
    expect(leads).toHaveLength(1);
    expect(leads[0].primaryPhone).toBe(OWNER_PHONE);
    expect(leads[0].sourceDetail).toBe('Voicemail recording RE-vm-1');

    // Twilio fetch used the account creds (authenticated RecordingUrl fetch).
    expect(h.fetchRecording).toHaveBeenCalledOnce();
    expect((h.fetchRecording as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      FINAL_PARAMS.RecordingUrl,
    );
    expect((h.fetchRecording as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(
      TWILIO_ACCOUNT_SID,
    );
    expect((h.fetchRecording as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(
      TWILIO_AUTH_TOKEN,
    );

    // S3 upload used the voicemail-specific key (never the call-recording
    // key, which the live leg's <Start><Record> owns on the same CallSid).
    const key = buildVoicemailStorageKey(TENANT_ID, 'CA-vm-1');
    expect(key).toContain('-voicemail');
    expect(h.storage.uploadKeys).toEqual([key]);
    expect(h.storage.lastUploadBucket).toBe(STORAGE_BUCKET);

    // voice_recordings row: idempotent insert, untrusted source, files FK.
    expect(h.pool.voiceRows).toHaveLength(1);
    expect(h.pool.voiceRows[0].tenant_id).toBe(TENANT_ID);
    expect(h.pool.voiceRows[0].call_sid).toBe('CA-vm-1');
    expect(h.pool.voiceRows[0].source).toBe('inbound_call');
    expect(h.pool.voiceRows[0].created_by).toBe('voicemail_webhook');
    expect(h.pool.voiceRows[0].duration_seconds).toBe(31);
    expect(h.pool.fileRows).toHaveLength(1);
    expect(h.pool.fileRows[0].s3_key).toBe(key);

    // Hand-off to the transcription enqueue: presigned GET + caller phone.
    expect(h.persistedEvents).toHaveLength(1);
    const event = h.persistedEvents[0];
    expect(event.tenantId).toBe(TENANT_ID);
    expect(event.voiceRecordingId).toBe(h.pool.voiceRows[0].id);
    expect(event.callerPhone).toBe(OWNER_PHONE);
    expect(event.inserted).toBe(true);
    expect(event.audioUrl).toBe(`https://s3.fake/${STORAGE_BUCKET}/${key}?sig=presigned-get`);

    // Audit events for both legs.
    const received = await h.auditRepo.findByEntity(TENANT_ID, 'lead', leads[0].id);
    expect(received.some((e) => e.eventType === 'voicemail.received')).toBe(true);
    const persisted = await h.auditRepo.findByEntity(
      TENANT_ID,
      'voice_recording',
      event.voiceRecordingId,
    );
    expect(persisted.some((e) => e.eventType === 'voicemail.recording_persisted')).toBe(true);
  });

  it('replay of the same RecordingSid duplicates NEITHER the lead NOR the recording row', async () => {
    const h = buildHarness({ sessionCallSid: 'CA-vm-1' });
    const r1 = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    const r2 = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(1);
    expect(h.pool.voiceRows).toHaveLength(1);
    // The replay short-circuits on the receipt: no second hand-off at all.
    expect(h.persistedEvents).toHaveLength(1);
    expect(h.fetchRecording).toHaveBeenCalledOnce();
  });

  it('without the receipt store, the recording row is STILL replay-safe and the hand-off marks inserted=false', async () => {
    const h = buildHarness({ sessionCallSid: 'CA-vm-1', withReceiptStore: false });
    await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);

    // recordInboundCall's (tenant, call_sid) idempotency held.
    expect(h.pool.voiceRows).toHaveLength(1);
    // Second hand-off says inserted=false so the app hook skips the enqueue.
    expect(h.persistedEvents).toHaveLength(2);
    expect(h.persistedEvents[0].inserted).toBe(true);
    expect(h.persistedEvents[1].inserted).toBe(false);
  });

  it('after-hours (no in-process session): tenant resolves via the To-number fallback from the signed URL', async () => {
    const resolveTenantId = vi.fn(({ to }: { to: string }) =>
      to === BUSINESS_PHONE ? TENANT_ID : undefined,
    );
    const h = buildHarness({
      // NO sessionCallSid — the after-hours branch answers before any
      // session exists.
      resolveTenantId: resolveTenantId as never,
    });
    const res = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(res.status).toBe(200);
    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(1);
    expect(h.pool.voiceRows).toHaveLength(1);
    expect(h.persistedEvents).toHaveLength(1);
  });

  it('unknown-caller voicemail still gets lead + transcription enqueue (owner gate lives downstream)', async () => {
    const h = buildHarness({ sessionCallSid: 'CA-vm-1' });
    const strangerQuery = `?From=${encodeURIComponent('+15550009999')}&To=${encodeURIComponent(BUSINESS_PHONE)}`;
    await signedVoicemailRequest(h.app, FINAL_PARAMS, strangerQuery);

    const leads = await h.leadRepo.findByTenant(TENANT_ID);
    expect(leads).toHaveLength(1);
    expect(leads[0].primaryPhone).toBe('+15550009999');
    expect(h.persistedEvents).toHaveLength(1);
    expect(h.persistedEvents[0].callerPhone).toBe('+15550009999');
  });

  it('non-final RecordingStatus is ignored without consuming the replay receipt', async () => {
    const h = buildHarness({ sessionCallSid: 'CA-vm-1' });
    await signedVoicemailRequest(
      h.app,
      { ...FINAL_PARAMS, RecordingStatus: 'in-progress' },
      CALLER_QUERY,
    );
    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(0);
    expect(h.pool.voiceRows).toHaveLength(0);

    // The final event afterwards still processes fully.
    await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(1);
    expect(h.pool.voiceRows).toHaveLength(1);
  });

  it('cross-leg collision, /recording FIRST: the voicemail still gets its own row and its transcription hand-off', async () => {
    const h = buildHarness({ sessionCallSid: 'CA-vm-1' });

    // Live-leg call recording lands first (the previously-broken order:
    // the voicemail leg then saw inserted=false and silently no-oped).
    const rec = await signedRecordingRequest(h.app, {
      CallSid: 'CA-vm-1',
      RecordingSid: 'RE-live-1',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-live-1',
      RecordingDuration: '95',
    });
    expect(rec.status).toBe(200);
    expect(h.pool.voiceRows).toHaveLength(1);

    const vm = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(vm.status).toBe(200);

    // TWO rows — one per recording — and the voicemail pipeline ran.
    expect(h.pool.voiceRows).toHaveLength(2);
    const urls = h.pool.voiceRows.map((r) => r.recording_url).sort();
    expect(urls).toEqual([
      FINAL_PARAMS.RecordingUrl,
      'https://api.twilio.com/2010-04-01/Recordings/RE-live-1',
    ].sort());
    expect(h.persistedEvents).toHaveLength(1);
    expect(h.persistedEvents[0].inserted).toBe(true);
    // Distinct S3 objects too — the voicemail key never clobbers the call leg's.
    expect(h.storage.uploadKeys).toContain(buildVoicemailStorageKey(TENANT_ID, 'CA-vm-1'));
    expect(h.storage.uploadKeys).toContain(`${TENANT_ID}/CA-vm-1.mp3`);
  });

  it('cross-leg collision, voicemail FIRST: the later /recording callback still inserts the call-leg row', async () => {
    const h = buildHarness({ sessionCallSid: 'CA-vm-1' });

    await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(h.pool.voiceRows).toHaveLength(1);
    expect(h.persistedEvents).toHaveLength(1);

    const rec = await signedRecordingRequest(h.app, {
      CallSid: 'CA-vm-1',
      RecordingSid: 'RE-live-1',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-live-1',
      RecordingDuration: '95',
    });
    expect(rec.status).toBe(200);
    expect(h.pool.voiceRows).toHaveLength(2);
  });

  it('at-least-once: a transient fetch failure answers 500, and the Twilio retry completes the pipeline without a duplicate lead', async () => {
    const fetchRecording = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(`Twilio recording fetch failed 503 for ${TWILIO_AUTH_TOKEN}`),
      )
      .mockResolvedValue(Buffer.from('ID3FAKEVOICEMAIL'));
    const h = buildHarness({ sessionCallSid: 'CA-vm-1', fetchRecording });

    // First delivery: lead lands (receipt-first), transcription leg fails →
    // 500 so Twilio retries (recording-webhook precedent). Nothing enqueued.
    const first = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(first.status).toBe(500);
    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(1);
    expect(h.pool.voiceRows).toHaveLength(0);
    expect(h.persistedEvents).toHaveLength(0);

    // Twilio retry: lead leg is receipt-guarded (no duplicate), the
    // transcription leg re-runs to completion.
    const retry = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(retry.status).toBe(200);
    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(1);
    expect(h.pool.voiceRows).toHaveLength(1);
    expect(h.persistedEvents).toHaveLength(1);
    expect(h.persistedEvents[0].inserted).toBe(true);

    // A LATER replay (post-success) is fully short-circuited by the
    // transcription receipt: no third fetch, no second hand-off.
    const replay = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(replay.status).toBe(200);
    expect(fetchRecording).toHaveBeenCalledTimes(2);
    expect(h.persistedEvents).toHaveLength(1);
  });

  it('at-least-once: a failing enqueue hook propagates (500) and the retry re-hands-off the already-inserted row', async () => {
    const persistedEvents: VoicemailPersistedEvent[] = [];
    const onVoicemailPersisted = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('queue unavailable');
      })
      .mockImplementation(async (event: VoicemailPersistedEvent) => {
        persistedEvents.push(event);
      });
    const h = buildHarness({ sessionCallSid: 'CA-vm-1', onVoicemailPersisted });

    const first = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(first.status).toBe(500);
    expect(h.pool.voiceRows).toHaveLength(1); // row committed before the hook

    // Retry: row insert dedupes (inserted=false — the create-then-crash
    // rescue), the hook runs again and succeeds, lead still single.
    const retry = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(retry.status).toBe(200);
    expect(h.pool.voiceRows).toHaveLength(1);
    expect(onVoicemailPersisted).toHaveBeenCalledTimes(2);
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0].inserted).toBe(false);
    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(1);
  });

  it('legacy shape (no receipt store): a transcription failure stays failure-soft 200 — a 500 there would duplicate the unguarded lead', async () => {
    const fetchRecording = vi.fn(async () => {
      throw new Error(`Twilio recording fetch failed 401 for ${TWILIO_AUTH_TOKEN}`);
    });
    const h = buildHarness({
      sessionCallSid: 'CA-vm-1',
      withReceiptStore: false,
      fetchRecording,
    });
    const res = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(res.status).toBe(200);
    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(1);
    expect(h.pool.voiceRows).toHaveLength(0);
    expect(h.persistedEvents).toHaveLength(0);
  });

  it('notify-only fallback: without Twilio creds the lead is still created and nothing else runs', async () => {
    const h = buildHarness({ sessionCallSid: 'CA-vm-1', withTranscriptionLeg: false });
    const res = await signedVoicemailRequest(h.app, FINAL_PARAMS, CALLER_QUERY);
    expect(res.status).toBe(200);
    expect(await h.leadRepo.findByTenant(TENANT_ID)).toHaveLength(1);
    expect(h.pool.voiceRows).toHaveLength(0);
    expect(h.persistedEvents).toHaveLength(0);
  });
});
