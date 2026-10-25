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
 *   3. PRIV-2 — the notify-only branch with no Twilio credentials records the
 *      Twilio copy it cannot delete as one `webhook_events` row (real columns),
 *      and a replayed callback does not add a second.
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL) — Docker-gated, CI only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import twilio from 'twilio';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { recordInboundCall } from '../../src/voice/voice-service';
import { PgWebhookEventRepository } from '../../src/webhooks/pg-webhook-event';
import {
  buildVoicemailStorageKey,
  createVoicemailStatusRouter,
  TWILIO_ORPHANED_COPY_PROVIDER,
} from '../../src/telephony/voicemail-status-route';
import { VoiceSessionStore } from '../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryLeadRepository } from '../../src/leads/in-memory-lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
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
      storageKey: buildVoicemailStorageKey(tenant.tenantId, callSid, 'RE-vm-int'),
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
      storageKey: `${tenant.tenantId}/${callSid}-RE-live-int.mp3`,
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
    // voicemail never clobbers the live leg's `<tenant>/<callSid>-<recordingSid>.mp3`).
    // Sort BOTH sides with the same JS comparator: Postgres ORDER BY uses the
    // database collation (linguistic — ranks "….mp3" before "…-voicemail.mp3"),
    // which disagrees with JS's code-unit sort ("-" < "."), so relying on the
    // SQL ordering makes the comparison collation-dependent.
    const files = await pool.query(
      `SELECT s3_key FROM files WHERE tenant_id = $1 AND entity_id = $2`,
      [tenant.tenantId, callSid],
    );
    expect(files.rows.map((r) => r.s3_key).sort()).toEqual(
      [
        buildVoicemailStorageKey(tenant.tenantId, callSid, 'RE-vm-int'),
        `${tenant.tenantId}/${callSid}-RE-live-int.mp3`,
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

  it('PRIV-2: a notify-only voicemail with no Twilio credentials leaves one webhook_events row naming the recording', async () => {
    const authToken = 'int-vm-orphan-token';
    const publicBaseUrl = 'https://api.int.test';
    const leadRepo = new InMemoryLeadRepository();
    const app = express();
    app.use(
      '/api/telephony',
      createVoicemailStatusRouter({
        store: new VoiceSessionStore(),
        pool,
        leadRepo,
        auditRepo: new InMemoryAuditRepository(),
        authTokenGetter: () => authToken,
        publicBaseUrl,
        resolveTenantIdFallback: () => tenant.tenantId,
        webhookEventRepo: new PgWebhookEventRepository(pool),
        // No storage and no Twilio credentials: the notify-only branch.
      }),
    );
    const recordingSid = `RE-vm-orphan-${Date.now()}`;
    const params = {
      CallSid: 'CA-vm-orphan',
      RecordingSid: recordingSid,
      RecordingUrl: `https://api.twilio.com/2010-04-01/Recordings/${recordingSid}`,
      RecordingDuration: '12',
      RecordingStatus: 'completed',
    };
    const path = '/api/telephony/voicemail-status?From=%2B15125550100&To=%2B15125550199';
    const post = () =>
      request(app)
        .post(path)
        .set('X-Twilio-Signature', twilio.getExpectedTwilioSignature(authToken, `${publicBaseUrl}${path}`, params))
        .type('form')
        .send(params);

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);

    const rows = await pool.query(
      `SELECT event_type, status, payload
         FROM webhook_events
        WHERE source = $1 AND idempotency_key = $2`,
      [TWILIO_ORPHANED_COPY_PROVIDER, `${tenant.tenantId}:${recordingSid}`],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].event_type).toBe('voicemail_twilio_copy_orphaned');
    expect(rows.rows[0].status).toBe('received');
    expect(rows.rows[0].payload).toEqual({
      tenantId: tenant.tenantId,
      callSid: 'CA-vm-orphan',
      recordingSid,
      recordingUrl: params.RecordingUrl,
      reason: 'no_credentials',
    });
    // The lead leg is untouched: one lead, deduped across the replay.
    expect(await leadRepo.findByTenant(tenant.tenantId)).toHaveLength(1);
  });
});
