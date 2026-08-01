/**
 * U9 (voicemail → action) — replay idempotency against real Postgres.
 *
 * The voicemail-status callback leans on two DB-level guarantees that a
 * mocked pool cannot prove (the mocked-DB trap CLAUDE.md warns about —
 * `docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md`):
 *
 *   1. `recordInboundCall` is idempotent on (tenant_id, call_sid,
 *      source='inbound_call') — a Twilio callback replay returns the
 *      ORIGINAL voice_recordings row (`inserted=false`) instead of a
 *      duplicate, with the voicemail-specific `created_by` and the
 *      `source` CHECK constraint intact on real columns.
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

  it('recordInboundCall dedupes a voicemail callback replay on (tenant_id, call_sid)', async () => {
    const callSid = `CA-vm-int-${Date.now()}`;
    const input = {
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

    const first = await recordInboundCall(pool, input);
    const replay = await recordInboundCall(pool, input);

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(replay.voiceRecordingId).toBe(first.voiceRecordingId);

    // Exactly one row landed, with the real column values the route relies
    // on — including source='inbound_call', which is what keeps voicemail
    // provenance UNTRUSTED (ratified U9 decision; fail-closed I13 classifier).
    const rows = await pool.query(
      `SELECT source, created_by, duration_seconds
         FROM voice_recordings
        WHERE tenant_id = $1 AND call_sid = $2`,
      [tenant.tenantId, callSid],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].source).toBe('inbound_call');
    expect(rows.rows[0].created_by).toBe('voicemail_webhook');
    expect(rows.rows[0].duration_seconds).toBe(27);
    expect(classifyRecordingProvenance({ source: rows.rows[0].source })).toBe('untrusted');

    // The files FK target carries the voicemail-specific storage key (the
    // live call leg's recording owns `<tenant>/<callSid>.mp3`).
    const files = await pool.query(
      `SELECT s3_key FROM files WHERE tenant_id = $1 AND entity_id = $2`,
      [tenant.tenantId, callSid],
    );
    expect(files.rows).toHaveLength(1);
    expect(files.rows[0].s3_key).toBe(buildVoicemailStorageKey(tenant.tenantId, callSid));
  });

  it('webhook receipt (lead-leg guard) inserts once per RecordingSid on the real unique index', async () => {
    const repo = new PgWebhookEventRepository(pool);
    const eventId = `${tenant.tenantId}:RE-vm-receipt-${Date.now()}`;

    const first = await repo.recordReceipt('twilio_voicemail', eventId, 'voicemail_completed', {
      callSid: 'CA-vm-int-receipt',
    });
    const replay = await repo.recordReceipt('twilio_voicemail', eventId, 'voicemail_completed', {
      callSid: 'CA-vm-int-receipt',
    });

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
  });
});
