/**
 * U9 (voicemail → action) — replay idempotency against real Postgres.
 *
 * The voicemail-status callback leans on two DB-level guarantees that a
 * mocked pool cannot prove (the mocked-DB trap CLAUDE.md warns about —
 * `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`):
 *
 *   1. `recordInboundCall` is idempotent on (tenant_id, call_sid,
 *      recording_url) — PER-RECORDING identity (review fix): a Twilio
 *      callback replay (same RecordingSid → same URL) returns the
 *      ORIGINAL voice_recordings row (`inserted=false`), while the SAME
 *      call's live-leg recording and voicemail (different URLs) get TWO
 *      rows — with the voicemail-specific `created_by` and the `source`
 *      CHECK constraint intact on real columns.
 *
 *   2. The webhook-events receipt (P0-014) that dedupes the LEAD leg:
 *      `recordReceipt` with the same (provider, eventId) inserts once —
 *      pinned here against the real `idx_webhook_idempotency` unique index.
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL) — Docker-gated, CI only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { recordInboundCall } from '../../src/voice/voice-service';
import { PgWebhookEventRepository } from '../../src/webhooks/pg-webhook-event';
import { buildVoicemailStorageKey } from '../../src/telephony/voicemail-status-route';
import { classifyRecordingProvenance } from '../../src/ai/content-provenance';

describe('Postgres integration — U9 voicemail replay idempotency', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('recordInboundCall: replay dedupes on (tenant_id, call_sid, recording_url); a second RECORDING of the same call is a second row', async () => {
    const callSid = `CA-vm-int-${Date.now()}`;
    const voicemailInput = {
      tenantId: tenant.tenantId,
      callSid,
      recordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-vm-int',
      durationSeconds: 27,
      storageBucket: 'serviceos-recordings',
      storageKey: buildVoicemailStorageKey(tenant.tenantId, callSid),
      sizeBytes: 12345,
      contentType: 'audio/mpeg',
      createdBy: 'voicemail_webhook',
    };

    const first = await recordInboundCall(pool, voicemailInput);
    const replay = await recordInboundCall(pool, voicemailInput);

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.voiceRecordingId).toBe(first.voiceRecordingId);

    // Cross-leg collision (review fix): the SAME call's live-leg recording
    // (different RecordingSid → different URL, /recording's storage key)
    // must be a SECOND row, not an inserted=false no-op.
    const liveLegInput = {
      ...voicemailInput,
      recordingUrl: 'https://api.twilio.com/2010-04-01/Recordings/RE-live-int',
      storageKey: `${tenant.tenantId}/${callSid}.mp3`,
      createdBy: 'twilio-recording-webhook',
      durationSeconds: 95,
    };
    const liveLeg = await recordInboundCall(pool, liveLegInput);
    expect(liveLeg.inserted).toBe(true);
    expect(liveLeg.voiceRecordingId).not.toBe(first.voiceRecordingId);
    const liveLegReplay = await recordInboundCall(pool, liveLegInput);
    expect(liveLegReplay.inserted).toBe(false);
    expect(liveLegReplay.voiceRecordingId).toBe(liveLeg.voiceRecordingId);

    // Real column values the route relies on — BOTH rows keep
    // source='inbound_call', which is what keeps voicemail provenance
    // UNTRUSTED (ratified U9 decision; fail-closed I13 classifier).
    // duration_seconds is NUMERIC (src/db/schema.ts) — node-pg returns it as
    // a string to preserve precision (production maps it via Number() in
    // pg-voice.ts), so cast to int here to pin the stored VALUE.
    const rows = await pool.query(
      `SELECT source, created_by, duration_seconds::int AS duration_seconds, recording_url
         FROM voice_recordings
        WHERE tenant_id = $1 AND call_sid = $2
        ORDER BY created_by`,
      [tenant.tenantId, callSid],
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.source).toBe('inbound_call');
      expect(classifyRecordingProvenance({ source: row.source })).toBe('untrusted');
    }
    const vmRow = rows.rows.find((r) => r.created_by === 'voicemail_webhook');
    expect(vmRow?.duration_seconds).toBe(27);
    expect(vmRow?.recording_url).toBe(voicemailInput.recordingUrl);

    // Each recording's files FK target carries its own storage key (the
    // voicemail never clobbers the live leg's `<tenant>/<callSid>.mp3`).
    const files = await pool.query(
      `SELECT s3_key FROM files WHERE tenant_id = $1 AND entity_id = $2 ORDER BY s3_key`,
      [tenant.tenantId, callSid],
    );
    expect(files.rows.map((r) => r.s3_key)).toEqual(
      [
        buildVoicemailStorageKey(tenant.tenantId, callSid),
        `${tenant.tenantId}/${callSid}.mp3`,
      ].sort(),
    );
  });

  it('per-leg webhook receipts insert once per RecordingSid on the real unique index', async () => {
    const repo = new PgWebhookEventRepository(pool);
    const eventId = `${tenant.tenantId}:RE-vm-receipt-${Date.now()}`;

    // Lead leg (receipt-first).
    const lead = await repo.recordReceipt('twilio_voicemail_lead', eventId, 'voicemail_lead', {
      callSid: 'CA-vm-int-receipt',
    });
    const leadReplay = await repo.recordReceipt(
      'twilio_voicemail_lead',
      eventId,
      'voicemail_lead',
      { callSid: 'CA-vm-int-receipt' },
    );
    expect(lead.inserted).toBe(true);
    expect(leadReplay.inserted).toBe(false);

    // Transcription leg (receipt-on-success) — a DIFFERENT provider, so
    // the two legs can never cross-consume each other's receipt, and the
    // route's pre-check read resolves it.
    expect(await repo.findById('twilio_voicemail_transcription', eventId)).toBeFalsy();
    const tx = await repo.recordReceipt(
      'twilio_voicemail_transcription',
      eventId,
      'voicemail_transcription',
      { callSid: 'CA-vm-int-receipt' },
    );
    expect(tx.inserted).toBe(true);
    expect(await repo.findById('twilio_voicemail_transcription', eventId)).toBeTruthy();
  });
});
