/**
 * PRIV-2 — the Twilio-hosted copy of a call recording is deleted once our
 * storage and our row hold it, and the retention sweep retries every copy not
 * yet confirmed gone. `recording_url` is never nulled.
 *
 * Production path at real Postgres with RLS_RUNTIME_ROLE on:
 *   - `createRecordingRouter` (the recording webhook) with the real
 *     `recordInboundCall` insert and the real `createTwilioCopyRemover` over
 *     `TwilioRecordingApiDeleter` + `PgRecordingRetentionRepository` +
 *     `PgAuditRepository` — only Twilio's HTTP (the recording GET and the
 *     recording DELETE) and the S3 PUT are mocked;
 *   - `runRecordingRetentionSweep` with `PgRecordingRetentionRepository`.
 * SQL fixtures only for what no product surface can produce: the tenant's
 * `recording_retention_days`, `legal_hold`, back-dated `created_at` /
 * `twilio_delete_attempted_at` (time passing), and a row tombstoned before
 * PRIV-2 existed. Real columns from migration 315 are read back directly.
 *
 * The shared container holds rows from other integration files, so only this
 * file's own ids and Twilio URLs are asserted on.
 */
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, type TestTenant } from './shared';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { DevStorageProvider } from '../../src/files/storage-provider';
import { createRecordingRouter } from '../../src/telephony/recording-webhook';
import {
  TwilioRecordingApiDeleter,
  createTwilioCopyRemover,
  TWILIO_COPY_DELETED_EVENT,
} from '../../src/telephony/twilio-recording-deleter';
import { recordInboundCall } from '../../src/voice/voice-service';
import {
  PgRecordingRetentionRepository,
  runRecordingRetentionSweep,
} from '../../src/workers/recording-retention-worker';
import { createLogger } from '../../src/logging/logger';

const SIGNING_TOKEN = 'test-signing-token-priv2';
const PUBLIC_BASE_URL = 'https://api.test';
const MASTER_SID = 'AC' + 'a'.repeat(32);
const MASTER_TOKEN = 'super-secret-twilio-token-priv2';
const BUCKET = 'test-bucket';
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

let pool: Pool;
let auditRepo: PgAuditRepository;
let retentionRepo: PgRecordingRetentionRepository;

/** Twilio's REST API as the deleter sees it: per-URL answers, every call logged. */
const twilioAnswers = new Map<string, number[]>();
const twilioCalls: Array<{ url: string; method: string; authorization: string }> = [];
const twilioFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  twilioCalls.push({
    url,
    method: init?.method ?? 'GET',
    authorization: (init?.headers as Record<string, string> | undefined)?.Authorization ?? '',
  });
  const queue = twilioAnswers.get(url);
  const status = queue && queue.length > 1 ? queue.shift()! : (queue?.[0] ?? 404);
  return new Response(status === 204 ? null : '{}', { status });
});
const deleter = new TwilioRecordingApiDeleter(MASTER_SID, MASTER_TOKEN, twilioFetch as unknown as typeof fetch);

const deleteObject = vi.fn(async () => undefined);
const storage = new DevStorageProvider({ bucket: 'dev', publicUrlBase: 'http://localhost:3000/dev' });
storage.deleteObject = deleteObject;

beforeAll(async () => {
  pool = await getSharedTestDb();
  auditRepo = new PgAuditRepository(pool);
  retentionRepo = new PgRecordingRetentionRepository(pool);
});

afterAll(async () => {
  await closeSharedTestDb();
});

function hex(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** A RecordingUrl as Twilio hands it to us: under the tenant's subaccount. */
function newRecording(): { recordingSid: string; recordingUrl: string; resource: string } {
  const subaccount = `AC${hex()}`;
  const recordingSid = `RE${hex()}`;
  const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${subaccount}/Recordings/${recordingSid}`;
  return { recordingSid, recordingUrl, resource: `${recordingUrl}.json` };
}

async function seedTenant(): Promise<TestTenant> {
  const t = await createTestTenant(pool);
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, recording_retention_days)
     VALUES (gen_random_uuid(), $1, $2, 365)`,
    [t.tenantId, 'Twilio Copy Co'],
  );
  return t;
}

async function recordingRow(tenantId: string, id: string) {
  const { rows } = await pool.query(
    `SELECT recording_url, twilio_deleted_at, twilio_delete_attempted_at, purged_at
       FROM voice_recordings WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  expect(rows).toHaveLength(1);
  return rows[0] as {
    recording_url: string;
    twilio_deleted_at: Date | null;
    twilio_delete_attempted_at: Date | null;
    purged_at: Date | null;
  };
}

async function copyDeletedEvents(tenantId: string, id: string) {
  return (await auditRepo.findByEntity(tenantId, 'voice_recording', id)).filter(
    (e) => e.eventType === TWILIO_COPY_DELETED_EVENT,
  );
}

function deletesOf(resource: string) {
  return twilioCalls.filter((c) => c.url === resource && c.method === 'DELETE');
}

/** The recording webhook exactly as app.ts mounts it, Twilio's HTTP mocked. */
function webhookApp(t: TestTenant, callSid: string) {
  const store = new VoiceSessionStore();
  store.create(t.tenantId, 'telephony', { callSid });
  const app = express();
  app.use(
    '/api/telephony',
    createRecordingRouter(
      {
        store,
        pool,
        storage,
        storageBucket: BUCKET,
        twilioAccountSid: MASTER_SID,
        twilioAuthToken: MASTER_TOKEN,
        authTokenGetter: () => SIGNING_TOKEN,
        publicBaseUrl: PUBLIC_BASE_URL,
      },
      {
        fetchRecording: async () => Buffer.from('ID3FAKEMP3'),
        uploadObject: async () => undefined,
        twilioCopyRemover: createTwilioCopyRemover(
          { deleter, repo: retentionRepo, auditRepo, logger },
          'recording_webhook',
        ),
      },
    ),
  );
  return app;
}

function deliverRecording(app: express.Application, params: Record<string, string>) {
  const path = '/api/telephony/recording';
  const sig = twilio.getExpectedTwilioSignature(SIGNING_TOKEN, `${PUBLIC_BASE_URL}${path}`, params);
  return request(app).post(path).set('X-Twilio-Signature', sig).type('form').send(params);
}

async function sweep() {
  return runRecordingRetentionSweep({
    repo: retentionRepo,
    storage,
    auditRepo,
    logger,
    twilioRecordingDeleter: deleter,
    // The shared container may hold other files' rows; reach this file's.
    twilioCopyBatchSize: 10_000,
  });
}

describe('PRIV-2 — the Twilio copy of a call recording', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await seedTenant();
  });

  it('the recording webhook stores the recording, then deletes the Twilio copy under its subaccount; recording_url is kept', async () => {
    const callSid = `CA${hex()}`;
    const rec = newRecording();
    twilioAnswers.set(rec.resource, [204]);

    const res = await deliverRecording(webhookApp(tenant, callSid), {
      CallSid: callSid,
      RecordingSid: rec.recordingSid,
      RecordingUrl: rec.recordingUrl,
      RecordingDuration: '42',
    });

    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT id FROM voice_recordings WHERE tenant_id = $1 AND call_sid = $2`,
      [tenant.tenantId, callSid],
    );
    expect(rows).toHaveLength(1);
    const id = String(rows[0].id);
    const deletes = deletesOf(rec.resource);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].authorization).toBe(
      `Basic ${Buffer.from(`${MASTER_SID}:${MASTER_TOKEN}`).toString('base64')}`,
    );
    const row = await recordingRow(tenant.tenantId, id);
    expect(row.twilio_deleted_at).toBeInstanceOf(Date);
    expect(row.recording_url).toBe(rec.recordingUrl);
    const events = await copyDeletedEvents(tenant.tenantId, id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: 'recording_webhook',
      metadata: { callSid, reason: 'stored_in_own_storage', alreadyGone: false },
    });

    // The sweep has nothing left to do for it.
    await sweep();
    expect(deletesOf(rec.resource)).toHaveLength(1);
    expect(await copyDeletedEvents(tenant.tenantId, id)).toHaveLength(1);
  });

  it('a delete that fails at ingest is recorded, and the sweep retries it after the grace window', async () => {
    const callSid = `CA${hex()}`;
    const rec = newRecording();
    twilioAnswers.set(rec.resource, [503, 204]);

    const res = await deliverRecording(webhookApp(tenant, callSid), {
      CallSid: callSid,
      RecordingSid: rec.recordingSid,
      RecordingUrl: rec.recordingUrl,
      RecordingDuration: '9',
    });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT id FROM voice_recordings WHERE tenant_id = $1 AND call_sid = $2`,
      [tenant.tenantId, callSid],
    );
    const id = String(rows[0].id);
    const failed = await recordingRow(tenant.tenantId, id);
    expect(failed.twilio_deleted_at).toBeNull();
    expect(failed.twilio_delete_attempted_at).toBeInstanceOf(Date);

    // Inside the grace window and the back-off: the sweep leaves it alone.
    await sweep();
    expect(deletesOf(rec.resource)).toHaveLength(1);

    // SQL fixture: two days pass.
    await pool.query(
      `UPDATE voice_recordings
          SET created_at = created_at - interval '2 days',
              twilio_delete_attempted_at = twilio_delete_attempted_at - interval '2 days'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, id],
    );
    const result = await sweep();

    expect(result.twilioCopiesDeleted).toBeGreaterThanOrEqual(1);
    expect(deletesOf(rec.resource)).toHaveLength(2);
    const retried = await recordingRow(tenant.tenantId, id);
    expect(retried.twilio_deleted_at).toBeInstanceOf(Date);
    expect(retried.recording_url).toBe(rec.recordingUrl);
    const events = await copyDeletedEvents(tenant.tenantId, id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorId: 'recording-retention-worker', metadata: { reason: 'retry' } });
  });

  it('a legacy recording tombstoned before PRIV-2 gets its Twilio copy deleted; 404 counts as done', async () => {
    const callSid = `CA${hex()}`;
    const rec = newRecording();
    twilioAnswers.set(rec.resource, [404]);
    const { voiceRecordingId } = await recordInboundCall(pool, {
      tenantId: tenant.tenantId,
      callSid,
      recordingUrl: rec.recordingUrl,
      durationSeconds: 30,
      storageBucket: BUCKET,
      storageKey: `${tenant.tenantId}/${callSid}.mp3`,
      sizeBytes: 1024,
    });
    // SQL fixture: recorded 500 days ago and purged (S3 only) by the old sweep.
    await pool.query(
      `UPDATE voice_recordings
          SET created_at = now() - interval '500 days', purged_at = now() - interval '135 days'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, voiceRecordingId],
    );

    await sweep();

    expect(deletesOf(rec.resource)).toHaveLength(1);
    const row = await recordingRow(tenant.tenantId, voiceRecordingId);
    expect(row.twilio_deleted_at).toBeInstanceOf(Date);
    expect(row.recording_url).toBe(rec.recordingUrl);
    const events = await copyDeletedEvents(tenant.tenantId, voiceRecordingId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ metadata: { reason: 'retry', alreadyGone: true } });
  });

  it('the horizon purge deletes the Twilio copy and records twilioDeleted; a re-run is idempotent and recording_url survives', async () => {
    const callSid = `CA${hex()}`;
    const rec = newRecording();
    twilioAnswers.set(rec.resource, [204]);
    const storageKey = `${tenant.tenantId}/${callSid}.mp3`;
    const { voiceRecordingId } = await recordInboundCall(pool, {
      tenantId: tenant.tenantId,
      callSid,
      recordingUrl: rec.recordingUrl,
      durationSeconds: 30,
      storageBucket: BUCKET,
      storageKey,
      sizeBytes: 1024,
    });
    // SQL fixture: recorded 400 days ago (past the 365-day horizon).
    await pool.query(
      `UPDATE voice_recordings SET created_at = now() - interval '400 days'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, voiceRecordingId],
    );

    await sweep();

    expect(deleteObject).toHaveBeenCalledWith(BUCKET, storageKey);
    expect(deletesOf(rec.resource)).toHaveLength(1);
    const row = await recordingRow(tenant.tenantId, voiceRecordingId);
    expect(row.purged_at).toBeInstanceOf(Date);
    expect(row.twilio_deleted_at).toBeInstanceOf(Date);
    expect(row.recording_url).toBe(rec.recordingUrl);
    const purged = (await auditRepo.findByEntity(tenant.tenantId, 'voice_recording', voiceRecordingId)).filter(
      (e) => e.eventType === 'voice_recording.purged',
    );
    expect(purged).toHaveLength(1);
    expect(purged[0].metadata).toMatchObject({ hadStoredObject: true, hadTwilioCopy: true, twilioDeleted: true });

    await sweep();

    expect(deletesOf(rec.resource)).toHaveLength(1);
    expect(await copyDeletedEvents(tenant.tenantId, voiceRecordingId)).toHaveLength(1);
    expect(
      (await auditRepo.findByEntity(tenant.tenantId, 'voice_recording', voiceRecordingId)).filter(
        (e) => e.eventType === 'voice_recording.purged',
      ),
    ).toHaveLength(1);
    expect((await recordingRow(tenant.tenantId, voiceRecordingId)).recording_url).toBe(rec.recordingUrl);
  });

  it('a recording on legal hold keeps its Twilio copy (a non-held one of the same age loses it)', async () => {
    async function seedThirtyDayOld(legalHold: boolean) {
      const callSid = `CA${hex()}`;
      const rec = newRecording();
      twilioAnswers.set(rec.resource, [204]);
      const { voiceRecordingId } = await recordInboundCall(pool, {
        tenantId: tenant.tenantId,
        callSid,
        recordingUrl: rec.recordingUrl,
        durationSeconds: 30,
        storageBucket: BUCKET,
        storageKey: `${tenant.tenantId}/${callSid}.mp3`,
        sizeBytes: 1024,
      });
      await pool.query(
        `UPDATE voice_recordings SET legal_hold = $3, created_at = now() - interval '30 days'
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, voiceRecordingId, legalHold],
      );
      return { rec, voiceRecordingId };
    }
    const held = await seedThirtyDayOld(true);
    const control = await seedThirtyDayOld(false);

    await sweep();

    // Positive control: the same sweep does delete a non-held copy of the
    // same age and tenant, so the held row's zero deletes are the exemption.
    expect(deletesOf(control.rec.resource)).toHaveLength(1);
    expect((await recordingRow(tenant.tenantId, control.voiceRecordingId)).twilio_deleted_at).toBeInstanceOf(Date);
    expect(deletesOf(held.rec.resource)).toHaveLength(0);
    expect((await recordingRow(tenant.tenantId, held.voiceRecordingId)).twilio_deleted_at).toBeNull();
  });

  it('the stamp is tenant-scoped: another tenant cannot mark this recording\'s copy deleted', async () => {
    const other = await seedTenant();
    const callSid = `CA${hex()}`;
    const rec = newRecording();
    const { voiceRecordingId } = await recordInboundCall(pool, {
      tenantId: tenant.tenantId,
      callSid,
      recordingUrl: rec.recordingUrl,
      durationSeconds: 30,
      storageBucket: BUCKET,
      storageKey: `${tenant.tenantId}/${callSid}.mp3`,
      sizeBytes: 1024,
    });

    expect(await retentionRepo.markTwilioCopyDeleted(other.tenantId, voiceRecordingId, new Date())).toBe(false);
    expect((await recordingRow(tenant.tenantId, voiceRecordingId)).twilio_deleted_at).toBeNull();
    expect(await retentionRepo.markTwilioCopyDeleted(tenant.tenantId, voiceRecordingId, new Date())).toBe(true);
    expect(await retentionRepo.markTwilioCopyDeleted(tenant.tenantId, voiceRecordingId, new Date())).toBe(false);
  });
});
