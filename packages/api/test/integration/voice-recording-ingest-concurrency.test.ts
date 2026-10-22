/**
 * LCR-04 — concurrent deliveries of ONE Twilio recording insert it once.
 *
 * `recordInboundCall` dedupes on (tenant_id, call_sid, recording_url) with a
 * SELECT … FOR UPDATE and then inserts a `files` row and a `voice_recordings`
 * row. FOR UPDATE locks no row that does not exist yet, and nothing is unique
 * on that triple, so two deliveries landing together (a Twilio callback retry,
 * or a callback racing a replay) both passed the check and both inserted: two
 * `files` rows, two `voice_recordings` rows, two transcription hand-offs.
 *
 * Only real Postgres can show this: whether two transactions serialize is
 * Postgres's locking, which the telephony unit tests' FakePool does not model
 * (the mocked-DB trap: docs/solutions/database-issues/
 * mocked-pool-hides-real-schema-mismatch.md).
 *
 * Runs under `npm run test:integration` (RLS_RUNTIME_ROLE=true, so every
 * ingest drops to `rls_app_runtime` inside its transaction) — Docker-gated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import {
  recordInboundCall,
  type RecordInboundCallInput,
  type RecordInboundCallResult,
} from '../../src/voice/voice-service';

/**
 * Deliveries fired at once per scenario. The pool holds exactly this many
 * connections, opened up front (beforeAll), so every delivery starts on a live
 * connection at the same moment: a smaller pool would queue them, and a cold
 * one would stagger them behind connection setup — either hides the race.
 */
const CONCURRENCY = 8;

function ingestInput(tenantId: string, callSid: string, recordingSid: string): RecordInboundCallInput {
  return {
    tenantId,
    callSid,
    recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC-lcr/Recordings/${recordingSid}`,
    durationSeconds: 42,
    storageBucket: 'serviceos-recordings',
    storageKey: `${tenantId}/${callSid}-${recordingSid}.mp3`,
    sizeBytes: 2048,
    contentType: 'audio/mpeg',
  };
}

async function voiceRecordingIds(pool: Pool, tenantId: string, callSid: string, recordingUrl: string) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM voice_recordings
      WHERE tenant_id = $1 AND call_sid = $2 AND recording_url = $3`,
    [tenantId, callSid, recordingUrl],
  );
  return rows.map((r) => r.id);
}

async function fileCount(pool: Pool, tenantId: string, s3Key: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM files WHERE tenant_id = $1 AND s3_key = $2`,
    [tenantId, s3Key],
  );
  return rows[0].n;
}

/** All deliveries of one recording agree on the row, and exactly one created it. */
function expectOneWinner(results: RecordInboundCallResult[], storedId: string): void {
  expect(results.filter((r) => r.inserted)).toHaveLength(1);
  expect(new Set(results.map((r) => r.voiceRecordingId))).toEqual(new Set([storedId]));
}

describe('Postgres integration — LCR-04 concurrent recording ingest', () => {
  let pool: Pool;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const shared = await getSharedTestDb();
    tenantA = await createTestTenant(shared);
    tenantB = await createTestTenant(shared);
    pool = new Pool({ connectionString: process.env.TEST_DB_URL, max: CONCURRENCY });
    const warm = await Promise.all(Array.from({ length: CONCURRENCY }, () => pool.connect()));
    for (const client of warm) client.release();
  });

  afterAll(async () => {
    await pool.end();
    await closeSharedTestDb();
  });

  it(`${CONCURRENCY} concurrent deliveries of one recording write one voice_recordings row and one files row`, async () => {
    const callSid = `CA-lcr-${randomUUID()}`;
    const input = ingestInput(tenantA.tenantId, callSid, 'RE-lcr-one');

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => recordInboundCall(pool, input)),
    );

    const stored = await voiceRecordingIds(pool, tenantA.tenantId, callSid, input.recordingUrl);
    expect(stored).toHaveLength(1);
    expect(await fileCount(pool, tenantA.tenantId, input.storageKey)).toBe(1);
    expectOneWinner(results, stored[0]);
  });

  it('two different recordings of one call, each delivered concurrently, still get a row each (U9)', async () => {
    const callSid = `CA-lcr-${randomUUID()}`;
    const liveLeg = ingestInput(tenantA.tenantId, callSid, 'RE-lcr-live');
    const voicemail = { ...ingestInput(tenantA.tenantId, callSid, 'RE-lcr-vm'), createdBy: 'voicemail_webhook' };

    // Interleave the two recordings' deliveries so they contend at once.
    const inputs = Array.from({ length: CONCURRENCY }, (_, i) => (i % 2 === 0 ? liveLeg : voicemail));
    const results = await Promise.all(inputs.map((input) => recordInboundCall(pool, input)));

    const liveIds = await voiceRecordingIds(pool, tenantA.tenantId, callSid, liveLeg.recordingUrl);
    const vmIds = await voiceRecordingIds(pool, tenantA.tenantId, callSid, voicemail.recordingUrl);
    expect(liveIds).toHaveLength(1);
    expect(vmIds).toHaveLength(1);
    expect(liveIds[0]).not.toBe(vmIds[0]);
    expect(await fileCount(pool, tenantA.tenantId, liveLeg.storageKey)).toBe(1);
    expect(await fileCount(pool, tenantA.tenantId, voicemail.storageKey)).toBe(1);

    expectOneWinner(results.filter((_, i) => inputs[i] === liveLeg), liveIds[0]);
    expectOneWinner(results.filter((_, i) => inputs[i] === voicemail), vmIds[0]);
  });

  it("another tenant's delivery of the same call_sid and recording_url is its own row, unaffected", async () => {
    const callSid = `CA-lcr-${randomUUID()}`;
    const inA = ingestInput(tenantA.tenantId, callSid, 'RE-lcr-shared');
    const inB = ingestInput(tenantB.tenantId, callSid, 'RE-lcr-shared');
    expect(inB.recordingUrl).toBe(inA.recordingUrl);

    const inputs = Array.from({ length: CONCURRENCY }, (_, i) => (i % 2 === 0 ? inA : inB));
    const results = await Promise.all(inputs.map((input) => recordInboundCall(pool, input)));

    const aIds = await voiceRecordingIds(pool, tenantA.tenantId, callSid, inA.recordingUrl);
    const bIds = await voiceRecordingIds(pool, tenantB.tenantId, callSid, inB.recordingUrl);
    expect(aIds).toHaveLength(1);
    expect(bIds).toHaveLength(1);
    expect(aIds[0]).not.toBe(bIds[0]);
    expect(await fileCount(pool, tenantA.tenantId, inA.storageKey)).toBe(1);
    expect(await fileCount(pool, tenantB.tenantId, inB.storageKey)).toBe(1);

    expectOneWinner(results.filter((_, i) => inputs[i] === inA), aIds[0]);
    expectOneWinner(results.filter((_, i) => inputs[i] === inB), bIds[0]);
  });
});
