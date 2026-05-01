/**
 * P8-014 — record_call recording webhook tests.
 *
 * Covers the four required test cases from the story:
 *   - Webhook rejects un-signed/forged requests
 *   - Happy path: Twilio fetch → S3 PUT → voice_recordings row created
 *   - Idempotency: second webhook with same RecordingSid is a no-op
 *   - Tenant scoping: row tenant matches the resolved session
 *   - Auth token not leaked in error messages
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { createTelephonyRouter } from '../../src/routes/telephony';
import { TwilioGatherAdapter } from '../../src/telephony/twilio-adapter';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import {
  buildRecordingStorageKey,
  createRecordingRouter,
} from '../../src/telephony/recording-webhook';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import type {
  StorageProvider,
  ObjectMetadata,
} from '../../src/files/file-service';

const AUTH_TOKEN = 'test-tw-token-recording';
const PUBLIC_BASE_URL = 'https://api.test';
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TWILIO_ACCOUNT_SID = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const TWILIO_AUTH_TOKEN = 'super-secret-twilio-token';
const STORAGE_BUCKET = 'serviceos-recordings';

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
  public lastUploadKey: string | null = null;
  public lastUploadBucket: string | null = null;
  public lastUploadContentType: string | null = null;

  async generateUploadUrl(
    bucket: string,
    key: string,
    contentType: string,
  ): Promise<string> {
    this.lastUploadBucket = bucket;
    this.lastUploadKey = key;
    this.lastUploadContentType = contentType;
    return `https://s3.fake/${bucket}/${key}?sig=presigned`;
  }
  async generateDownloadUrl(bucket: string, key: string): Promise<string> {
    return `https://s3.fake/${bucket}/${key}`;
  }
  async getObjectMetadata(): Promise<ObjectMetadata | null> {
    return null;
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
  status: string;
}

/**
 * Minimal pg.Pool stub: tracks INSERTs and supports SELECT-by-callSid for
 * idempotency. Just enough surface area for `recordInboundCall` —
 * .connect()/.query()/.release() — without spinning up testcontainers.
 */
class FakePool {
  public voiceRows: VoiceRecordingRow[] = [];
  public fileRows: Array<Record<string, unknown>> = [];
  public queryLog: string[] = [];

  async connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: () => void;
  }> {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        this.queryLog.push(sql.trim().split('\n')[0]);
        if (/SELECT id FROM voice_recordings/i.test(sql)) {
          const tenantId = params[0] as string;
          const callSid = params[1] as string;
          const match = this.voiceRows.find(
            (r) =>
              r.tenant_id === tenantId &&
              r.call_sid === callSid &&
              r.source === 'inbound_call',
          );
          return { rows: match ? [{ id: match.id }] : [] };
        }
        if (/INSERT INTO files/i.test(sql)) {
          this.fileRows.push({
            id: params[0],
            tenant_id: params[1],
            filename: params[2],
            content_type: params[3],
            size_bytes: params[4],
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
            status: 'completed',
          });
          return { rows: [] };
        }
        // SET app.current_tenant_id ... — accept silently.
        return { rows: [] };
      },
      release: () => {
        // no-op
      },
    };
  }
}

interface HarnessOptions {
  pool?: FakePool;
  storage?: FakeStorageProvider;
  fetchRecording?: (
    url: string,
    sid: string,
    token: string,
  ) => Promise<Buffer>;
  uploadObject?: (url: string, bytes: Buffer, contentType: string) => Promise<void>;
}

function buildHarness(opts: HarnessOptions = {}) {
  const store = new VoiceSessionStore();
  const gateway = makeGateway();
  const storage = opts.storage ?? new FakeStorageProvider();
  const pool = opts.pool ?? new FakePool();

  // Pre-create a session bound to a known CallSid so the recording
  // handler can resolve tenant via VoiceSessionStore.findByCallSid.
  const session = store.create(TENANT_ID, 'telephony', { callSid: 'CA-rec-1' });

  const adapter = new TwilioGatherAdapter({
    store,
    gateway,
    businessName: 'Test Co',
    publicBaseUrl: PUBLIC_BASE_URL,
    recordingCallbackPath: '/api/telephony/recording',
  });

  const app = express();
  app.use(
    '/api/telephony',
    createTelephonyRouter({
      adapter,
      authTokenGetter: () => AUTH_TOKEN,
      publicBaseUrl: PUBLIC_BASE_URL,
      resolveTenantId: () => TENANT_ID,
      recording: {
        store,
        pool: pool as unknown as import('pg').Pool,
        storage,
        storageBucket: STORAGE_BUCKET,
        twilioAccountSid: TWILIO_ACCOUNT_SID,
        twilioAuthToken: TWILIO_AUTH_TOKEN,
        options: {
          ...(opts.fetchRecording ? { fetchRecording: opts.fetchRecording } : {}),
          ...(opts.uploadObject ? { uploadObject: opts.uploadObject } : {}),
        },
      },
    }),
  );

  return { app, store, storage, pool, session };
}

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

describe('P8-014 record_call recording webhook', () => {
  describe('signature enforcement', () => {
    it('rejects forged requests with 403', async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .post('/api/telephony/recording')
        .type('form')
        .send({
          CallSid: 'CA-rec-1',
          RecordingSid: 'RE111',
          RecordingUrl: 'https://api.twilio.com/2010-04-01/RE111',
          RecordingDuration: '12',
        });
      expect(res.status).toBe(403);
    });

    it('rejects requests with a wrong signature', async () => {
      const { app } = buildHarness();
      const res = await request(app)
        .post('/api/telephony/recording')
        .set('X-Twilio-Signature', 'not-a-real-signature')
        .type('form')
        .send({
          CallSid: 'CA-rec-1',
          RecordingSid: 'RE111',
          RecordingUrl: 'https://api.twilio.com/2010-04-01/RE111',
          RecordingDuration: '12',
        });
      expect(res.status).toBe(403);
    });
  });

  describe('happy path', () => {
    it('fetches Twilio bytes, PUTs to S3, and inserts a voice_recordings row', async () => {
      const fakeBytes = Buffer.from('ID3FAKEMP3CONTENT');
      const fetchRecording = vi.fn(async () => fakeBytes);
      const uploadCalls: Array<{ url: string; bytes: Buffer; contentType: string }> = [];
      const uploadObject = vi.fn(async (url: string, bytes: Buffer, contentType: string) => {
        uploadCalls.push({ url, bytes, contentType });
      });
      const { app, pool, storage } = buildHarness({ fetchRecording, uploadObject });

      const res = await signedRecordingRequest(app, {
        CallSid: 'CA-rec-1',
        RecordingSid: 'RE-happy',
        RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-happy',
        RecordingDuration: '42',
      });

      expect(res.status).toBe(200);
      expect(fetchRecording).toHaveBeenCalledOnce();
      expect(fetchRecording.mock.calls[0][1]).toBe(TWILIO_ACCOUNT_SID);
      expect(fetchRecording.mock.calls[0][2]).toBe(TWILIO_AUTH_TOKEN);

      // S3 PUT used the tenant-scoped key from buildRecordingStorageKey.
      expect(storage.lastUploadKey).toBe(
        buildRecordingStorageKey(TENANT_ID, 'CA-rec-1'),
      );
      expect(storage.lastUploadBucket).toBe(STORAGE_BUCKET);
      expect(storage.lastUploadContentType).toBe('audio/mpeg');
      expect(uploadCalls).toHaveLength(1);
      expect(uploadCalls[0].bytes).toBe(fakeBytes);
      expect(uploadCalls[0].contentType).toBe('audio/mpeg');

      // voice_recordings row inserted with the right shape.
      expect(pool.voiceRows).toHaveLength(1);
      const row = pool.voiceRows[0];
      expect(row.tenant_id).toBe(TENANT_ID);
      expect(row.call_sid).toBe('CA-rec-1');
      expect(row.source).toBe('inbound_call');
      expect(row.status).toBe('completed');
      expect(row.duration_seconds).toBe(42);
      expect(row.recording_url).toBe(
        'https://api.twilio.com/2010-04-01/Recordings/RE-happy',
      );

      // files row was inserted as the FK target with the same key.
      expect(pool.fileRows).toHaveLength(1);
      expect(pool.fileRows[0].s3_bucket).toBe(STORAGE_BUCKET);
      expect(pool.fileRows[0].s3_key).toBe(
        buildRecordingStorageKey(TENANT_ID, 'CA-rec-1'),
      );
    });
  });

  describe('idempotency', () => {
    it('a second delivery for the same RecordingSid is a no-op', async () => {
      const fakeBytes = Buffer.from('mp3bytes');
      const fetchRecording = vi.fn(async () => fakeBytes);
      const uploadObject = vi.fn(async () => undefined);
      const { app, pool } = buildHarness({ fetchRecording, uploadObject });

      const params = {
        CallSid: 'CA-rec-1',
        RecordingSid: 'RE-dup',
        RecordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-dup',
        RecordingDuration: '7',
      };
      const r1 = await signedRecordingRequest(app, params);
      const r2 = await signedRecordingRequest(app, params);

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      // Only one voice_recordings + one files row, not two.
      expect(pool.voiceRows).toHaveLength(1);
      expect(pool.fileRows).toHaveLength(1);
      // Note: fetch + upload still ran twice (the recording handler
      // does the dedupe at the DB layer); a future optimization could
      // SELECT first, but the requirement is that the row not double.
    });
  });

  describe('tenant scoping', () => {
    it('uses the tenant from the session, never from the payload', async () => {
      const fakeBytes = Buffer.from('mp3');
      const fetchRecording = vi.fn(async () => fakeBytes);
      const uploadObject = vi.fn(async () => undefined);
      const { app, pool, storage } = buildHarness({ fetchRecording, uploadObject });

      // Twilio's payload carries an AccountSid (which a forger could
      // claim was for a different tenant). Our handler must IGNORE
      // anything in the payload that smells like a tenant — only
      // VoiceSessionStore.findByCallSid is trusted.
      const FORGED_ACCOUNT = 'ACfffffffffffffffffffffffffffffffe';
      const res = await signedRecordingRequest(app, {
        CallSid: 'CA-rec-1',
        RecordingSid: 'RE-scoped',
        RecordingUrl: 'https://api.twilio.com/2010-04-01/RE-scoped',
        RecordingDuration: '5',
        AccountSid: FORGED_ACCOUNT,
        // Even an explicit (forged) tenant_id field must be ignored.
        tenant_id: '99999999-9999-9999-9999-999999999999',
      });

      expect(res.status).toBe(200);
      expect(pool.voiceRows).toHaveLength(1);
      expect(pool.voiceRows[0].tenant_id).toBe(TENANT_ID);
      expect(pool.fileRows[0].tenant_id).toBe(TENANT_ID);
      // Storage key starts with the resolved tenant, never the payload's.
      expect(storage.lastUploadKey?.startsWith(TENANT_ID)).toBe(true);
    });

    it('falls back to resolveTenantId when no session matches the CallSid', async () => {
      // Recording callbacks can land on a different process instance or
      // arrive after a session has been reaped. The webhook accepts a
      // `resolveTenantIdFallback` (wired by the route from the parent
      // `resolveTenantId`) so the recording is still persisted instead
      // of dropped on the floor. Twilio's signature is verified upstream,
      // so trusting `Called`/`To` here is no less safe than trusting any
      // other signed field.
      const fakeBytes = Buffer.from('mp3');
      const fetchRecording = vi.fn(async () => fakeBytes);
      const uploadObject = vi.fn(async () => undefined);
      const { app, pool } = buildHarness({ fetchRecording, uploadObject });

      const res = await signedRecordingRequest(app, {
        CallSid: 'CA-not-in-store',
        RecordingSid: 'RE-orphan',
        RecordingUrl: 'https://api.twilio.com/2010-04-01/RE-orphan',
        RecordingDuration: '3',
        Called: '+15125551111',
        Caller: '+15125552222',
      });

      expect(res.status).toBe(200);
      expect(pool.voiceRows).toHaveLength(1);
      // Tenant came from the fallback (resolveTenantId returns TENANT_ID
      // in the harness), not from the payload.
      expect(pool.voiceRows[0].tenant_id).toBe(TENANT_ID);
      expect(fetchRecording).toHaveBeenCalled();
    });

    it('returns 200 (no row) when no session matches and no fallback is wired', async () => {
      // Build a router without `recording.resolveTenantIdFallback` by
      // not wiring `resolveTenantId` to anything useful (returns
      // undefined). Since `createTelephonyRouter` always passes
      // `resolveTenantId` through, simulate the no-fallback case by
      // having it return undefined for the orphan CallSid.
      const fakeBytes = Buffer.from('mp3');
      const fetchRecording = vi.fn(async () => fakeBytes);
      const uploadObject = vi.fn(async () => undefined);
      const store = new VoiceSessionStore();
      const gateway = makeGateway();
      const storage = new FakeStorageProvider();
      const pool = new FakePool();
      store.create(TENANT_ID, 'telephony', { callSid: 'CA-rec-1' });

      const adapter = new TwilioGatherAdapter({
        store,
        gateway,
        businessName: 'Test Co',
        publicBaseUrl: PUBLIC_BASE_URL,
        recordingCallbackPath: '/api/telephony/recording',
      });
      const app = express();
      app.use(
        '/api/telephony',
        createTelephonyRouter({
          adapter,
          authTokenGetter: () => AUTH_TOKEN,
          publicBaseUrl: PUBLIC_BASE_URL,
          // Explicitly returns undefined so the fallback can't resolve.
          resolveTenantId: () => undefined,
          recording: {
            store,
            pool: pool as unknown as import('pg').Pool,
            storage,
            storageBucket: STORAGE_BUCKET,
            twilioAccountSid: TWILIO_ACCOUNT_SID,
            twilioAuthToken: TWILIO_AUTH_TOKEN,
            options: { fetchRecording, uploadObject },
          },
        }),
      );

      const res = await signedRecordingRequest(app, {
        CallSid: 'CA-not-in-store',
        RecordingSid: 'RE-orphan-2',
        RecordingUrl: 'https://api.twilio.com/2010-04-01/RE-orphan-2',
        RecordingDuration: '3',
      });

      expect(res.status).toBe(200);
      expect(pool.voiceRows).toHaveLength(0);
      expect(fetchRecording).not.toHaveBeenCalled();
    });
  });

  describe('auth token redaction', () => {
    it('strips TWILIO_AUTH_TOKEN from error messages bubbled up by failures', async () => {
      // Force the Twilio fetch to throw an error string that contains
      // the auth token. The handler must redact it before logging /
      // returning.
      const fetchRecording = vi.fn(async () => {
        throw new Error(
          `Auth Basic ${Buffer.from(
            `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`,
          ).toString('base64')} also raw=${TWILIO_AUTH_TOKEN}`,
        );
      });
      const { app, pool } = buildHarness({ fetchRecording });

      // Capture all log lines — the logger writes structured JSON to
      // process.stderr / process.stdout.
      const stderrChunks: string[] = [];
      const stdoutChunks: string[] = [];
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: unknown) => {
          stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
          return true;
        });
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
          return true;
        });

      const res = await signedRecordingRequest(app, {
        CallSid: 'CA-rec-1',
        RecordingSid: 'RE-fail',
        RecordingUrl: 'https://api.twilio.com/2010-04-01/RE-fail',
        RecordingDuration: '0',
      });

      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();

      expect(res.status).toBe(500);
      // The bubbled response body must not include the token.
      expect(res.text).not.toContain(TWILIO_AUTH_TOKEN);
      // The token must not appear in any log line.
      const allLogLines = [...stderrChunks, ...stdoutChunks];
      for (const line of allLogLines) {
        expect(line).not.toContain(TWILIO_AUTH_TOKEN);
      }
      // But the redaction marker should appear somewhere — at least one
      // log line acknowledges the failure with the scrubbed message.
      expect(allLogLines.some((l) => l.includes('<redacted>'))).toBe(true);

      // No row was inserted (fetch failed before persistence).
      expect(pool.voiceRows).toHaveLength(0);
    });
  });

  describe('field validation', () => {
    it('rejects requests missing CallSid/RecordingSid/RecordingUrl with 400', async () => {
      const { app } = buildHarness();
      const res = await signedRecordingRequest(app, {
        // CallSid intentionally omitted
        RecordingSid: 'RE-x',
        RecordingUrl: 'https://x',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('createRecordingRouter standalone', () => {
    it('exposes POST /recording when mounted directly (no parent telephony router)', async () => {
      const store = new VoiceSessionStore();
      store.create(TENANT_ID, 'telephony', { callSid: 'CA-direct' });
      const storage = new FakeStorageProvider();
      const pool = new FakePool();
      const recordingRouter = createRecordingRouter(
        {
          store,
          pool: pool as unknown as import('pg').Pool,
          storage,
          storageBucket: STORAGE_BUCKET,
          twilioAccountSid: TWILIO_ACCOUNT_SID,
          twilioAuthToken: TWILIO_AUTH_TOKEN,
          authTokenGetter: () => AUTH_TOKEN,
          publicBaseUrl: PUBLIC_BASE_URL,
        },
        {
          fetchRecording: async () => Buffer.from('x'),
          uploadObject: async () => undefined,
        },
      );
      const app = express();
      app.use('/api/telephony', recordingRouter);

      const params = {
        CallSid: 'CA-direct',
        RecordingSid: 'RE-direct',
        RecordingUrl: 'https://api.twilio.com/RE-direct',
        RecordingDuration: '1',
      };
      const url = `${PUBLIC_BASE_URL}/api/telephony/recording`;
      const sig = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
      const res = await request(app)
        .post('/api/telephony/recording')
        .set('X-Twilio-Signature', sig)
        .type('form')
        .send(params);

      expect(res.status).toBe(200);
      expect(pool.voiceRows).toHaveLength(1);
    });
  });
});

describe('buildRecordingStorageKey', () => {
  it('puts the tenant id first so prefix-scoped IAM works', () => {
    expect(buildRecordingStorageKey('tenant-a', 'CA123')).toBe('tenant-a/CA123.mp3');
  });
});
