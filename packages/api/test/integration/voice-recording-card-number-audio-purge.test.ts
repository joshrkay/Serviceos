/**
 * PRIV-3 — a card number recited on a call: the stored transcript carries the
 * `[card number]` marker (callerTranscriptText), the recording is flagged
 * `pci_detected` when the webhook's transcript hook sees the marker, and the
 * retention sweep deletes that recording's stored audio promptly (long before
 * the tenant's horizon), stamps `audio_purged_at` and audits it.
 *
 * Every write goes through the production path at real Postgres with
 * RLS_RUNTIME_ROLE on: `recordInboundCall` (the recording webhook's writer),
 * `PgCallTranscriptTurnRepository.recordTurn` with text from
 * `callerTranscriptText` (what `VoiceSessionStore.persistTurn` stores),
 * `createRecordingTranscriptHook` with the Pg repos (the webhook's
 * `onPersisted`), and `runRecordingRetentionSweep` with
 * `PgRecordingRetentionRepository`. SQL fixtures only for what no product
 * surface can produce (`recording_retention_days`, `legal_hold`) and for
 * reading the real columns the fix adds (migration 314).
 *
 * The shared container holds tenants from other integration files, so only
 * row-level assertions on this file's own ids are made.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb, type TestTenant } from './shared';
import { PgCallTranscriptTurnRepository } from '../../src/voice/pg-call-transcript-turn';
import { PgVoiceRepository } from '../../src/voice/pg-voice';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { DevStorageProvider } from '../../src/files/storage-provider';
import { recordInboundCall } from '../../src/voice/voice-service';
import { callerTranscriptText } from '../../src/ai/voice-turn/transcript-append';
import { createRecordingTranscriptHook } from '../../src/telephony/recording-transcript-hook';
import {
  PgRecordingRetentionRepository,
  runRecordingRetentionSweep,
} from '../../src/workers/recording-retention-worker';
import { createLogger } from '../../src/logging/logger';

const SPOKEN = 'can I just pay now, my card is 4111 1111 1111 1111 expires 09/27';
const BUCKET = 'test-bucket';
const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

let pool: Pool;
let turnRepo: PgCallTranscriptTurnRepository;
let voiceRepo: PgVoiceRepository;
let auditRepo: PgAuditRepository;

beforeAll(async () => {
  pool = await getSharedTestDb();
  turnRepo = new PgCallTranscriptTurnRepository(pool);
  voiceRepo = new PgVoiceRepository(pool);
  auditRepo = new PgAuditRepository(pool);
});

afterAll(async () => {
  await closeSharedTestDb();
});

async function seedTenant(): Promise<TestTenant> {
  const t = await createTestTenant(pool);
  // SQL fixture: recording_retention_days has no settings write surface.
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, recording_retention_days)
     VALUES (gen_random_uuid(), $1, $2, 365)`,
    [t.tenantId, 'Card Number Co'],
  );
  return t;
}

function newCallSid(): string {
  return `CA${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * One finished call as production leaves it before the recording webhook
 * fires: mid-call turns persisted by `persistTurn` (caller text through
 * `callerTranscriptText`), then the webhook's insert and its transcript hook.
 */
async function finishedCall(
  t: TestTenant,
  callerLine: string,
): Promise<{ voiceRecordingId: string; callSid: string; storageKey: string }> {
  const callSid = newCallSid();
  const sessionId = crypto.randomUUID();
  const lines: ReadonlyArray<readonly ['agent' | 'caller', string]> = [
    ['agent', 'you owe one hundred twenty dollars'],
    ['caller', callerTranscriptText({}, callerLine)],
  ];
  for (let i = 0; i < lines.length; i++) {
    await turnRepo.recordTurn({
      tenantId: t.tenantId,
      callSid,
      sessionId,
      turnIndex: i,
      speaker: lines[i][0],
      text: lines[i][1],
    });
  }
  const storageKey = `${t.tenantId}/${callSid}.mp3`;
  const { voiceRecordingId, inserted } = await recordInboundCall(pool, {
    tenantId: t.tenantId,
    callSid,
    recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE${crypto.randomUUID().replace(/-/g, '')}`,
    durationSeconds: 30,
    storageBucket: BUCKET,
    storageKey,
    sizeBytes: 1024,
    contentType: 'audio/mpeg',
  });
  expect(inserted).toBe(true);
  const hook = createRecordingTranscriptHook({
    store: { findByCallSidIncludingEnded: () => undefined },
    callTranscriptTurnRepo: turnRepo,
    voiceRepo,
    auditRepo,
    logger,
  });
  await hook({ tenantId: t.tenantId, voiceRecordingId, callSid, durationSeconds: 30, inserted: true });
  return { voiceRecordingId, callSid, storageKey };
}

async function recordingRow(tenantId: string, id: string) {
  const { rows } = await pool.query(
    `SELECT pci_detected, audio_purged_at, purged_at, transcript
       FROM voice_recordings WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  expect(rows).toHaveLength(1);
  return rows[0] as {
    pci_detected: boolean;
    audio_purged_at: Date | null;
    purged_at: Date | null;
    transcript: string | null;
  };
}

describe('PRIV-3 — card number recited on a call: flag and prompt audio purge', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let flagged: Awaited<ReturnType<typeof finishedCall>>;
  let clean: Awaited<ReturnType<typeof finishedCall>>;
  let held: Awaited<ReturnType<typeof finishedCall>>;
  const deleteObject = vi.fn(async () => undefined);
  const storage = new DevStorageProvider({ bucket: 'dev', publicUrlBase: 'http://localhost:3000/dev' });
  storage.deleteObject = deleteObject;

  beforeAll(async () => {
    tenantA = await seedTenant();
    tenantB = await seedTenant();
    flagged = await finishedCall(tenantA, SPOKEN);
    clean = await finishedCall(tenantA, 'call me back on 602 555 0199, the gate code is 4821');
    held = await finishedCall(tenantB, SPOKEN);
    // SQL fixture: legal_hold has no setter.
    await pool.query(
      `UPDATE voice_recordings SET legal_hold = true WHERE tenant_id = $1 AND id = $2`,
      [tenantB.tenantId, held.voiceRecordingId],
    );
  });

  it('the stored caller turn carries the marker, never the digits', async () => {
    const turns = await turnRepo.listByRecording(tenantA.tenantId, flagged.voiceRecordingId);
    const caller = turns.filter((t) => t.speaker === 'caller').map((t) => t.text);
    expect(caller).toEqual(['can I just pay now, my card is [card number] expires 09/27']);
  });

  it('the transcript hook flags the recording whose transcript carries the marker, and only that one', async () => {
    expect((await recordingRow(tenantA.tenantId, flagged.voiceRecordingId)).pci_detected).toBe(true);
    expect((await recordingRow(tenantA.tenantId, clean.voiceRecordingId)).pci_detected).toBe(false);
    expect((await recordingRow(tenantB.tenantId, held.voiceRecordingId)).pci_detected).toBe(true);
  });

  it('the flag is audited once per recording, by the webhook, and never on a clean call', async () => {
    const flaggedEvents = (
      await auditRepo.findByEntity(tenantA.tenantId, 'voice_recording', flagged.voiceRecordingId)
    ).filter((e) => e.eventType === 'voice_recording.card_number_detected');
    expect(flaggedEvents).toHaveLength(1);
    expect(flaggedEvents[0]).toMatchObject({
      actorId: 'recording_webhook',
      actorRole: 'system',
      metadata: { source: 'call_transcript' },
    });
    // A second flag write (a webhook retry) changes nothing.
    expect(await voiceRepo.markCardNumberDetected(tenantA.tenantId, flagged.voiceRecordingId)).toBe(false);
  });

  describe('after one retention sweep', () => {
    let result: Awaited<ReturnType<typeof runRecordingRetentionSweep>>;

    beforeAll(async () => {
      deleteObject.mockClear();
      result = await runRecordingRetentionSweep({
        repo: new PgRecordingRetentionRepository(pool),
        storage,
        auditRepo,
        logger,
      });
    });

    it('deletes the flagged recording\'s stored audio although it is nowhere near the horizon', () => {
      expect(deleteObject).toHaveBeenCalledWith(BUCKET, flagged.storageKey);
      expect(deleteObject).not.toHaveBeenCalledWith(BUCKET, clean.storageKey);
      expect(result.cardNumberAudioPurged).toBeGreaterThanOrEqual(1);
      expect(result.cardNumberAudioFailed).toBe(0);
    });

    it('stamps audio_purged_at on the flagged row and keeps the row, its transcript and the horizon tombstone', async () => {
      const row = await recordingRow(tenantA.tenantId, flagged.voiceRecordingId);
      expect(row.audio_purged_at).not.toBeNull();
      expect(row.purged_at).toBeNull();
      expect(row.pci_detected).toBe(true);
      // What the audio download route reads to answer 410.
      const rec = await voiceRepo.findById(tenantA.tenantId, flagged.voiceRecordingId);
      expect(rec?.audioPurgedAt).toEqual(row.audio_purged_at);
      expect(rec?.purgedAt).toBeUndefined();
      const turns = await turnRepo.listByRecording(tenantA.tenantId, flagged.voiceRecordingId);
      expect(turns).toHaveLength(2);
    });

    it('leaves the clean recording and the legal-hold recording alone', async () => {
      expect((await recordingRow(tenantA.tenantId, clean.voiceRecordingId)).audio_purged_at).toBeNull();
      expect((await recordingRow(tenantB.tenantId, held.voiceRecordingId)).audio_purged_at).toBeNull();
      expect(deleteObject).not.toHaveBeenCalledWith(BUCKET, held.storageKey);
    });

    it('emits one system audit event for the flagged recording\'s audio delete', async () => {
      const events = (
        await auditRepo.findByEntity(tenantA.tenantId, 'voice_recording', flagged.voiceRecordingId)
      ).filter((e) => e.eventType === 'voice_recording.audio_purged');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorId: 'recording-retention-worker',
        actorRole: 'system',
        entityType: 'voice_recording',
      });
      expect(events[0].metadata).toMatchObject({
        callSid: flagged.callSid,
        reason: 'card_number_detected',
        hadStoredObject: true,
      });
      expect(
        await auditRepo.findByEntity(tenantA.tenantId, 'voice_recording', clean.voiceRecordingId),
      ).toEqual([]);
    });

    it('a second sweep is idempotent: no second delete, no second audit event', async () => {
      deleteObject.mockClear();
      await runRecordingRetentionSweep({
        repo: new PgRecordingRetentionRepository(pool),
        storage,
        auditRepo,
        logger,
      });
      expect(deleteObject).not.toHaveBeenCalledWith(BUCKET, flagged.storageKey);
      const events = (
        await auditRepo.findByEntity(tenantA.tenantId, 'voice_recording', flagged.voiceRecordingId)
      ).filter((e) => e.eventType === 'voice_recording.audio_purged');
      expect(events).toHaveLength(1);
    });
  });
});
