/**
 * RIVET I13 — voice_recordings transcript provenance stamp against real
 * Postgres.
 *
 * The stamp MUST merge into transcript_metadata (jsonb `||`), never replace:
 * the transcription worker writes a rich metadata object at completion
 * (sanitization_version, raw_transcript_retention, …) and the ingestion
 * worker stamps AFTER it. A mocked pool cannot prove `||` semantics or the
 * real column names — this pins them (the mocked-DB trap CLAUDE.md warns
 * about).
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, createTestFile, closeSharedTestDb } from './shared';
import { PgVoiceRepository } from '../../src/voice/pg-voice';
import { classifyRecordingProvenance } from '../../src/ai/content-provenance';

describe('Postgres integration — voice recording provenance stamp (I13)', () => {
  let pool: Pool;
  let voiceRepo: PgVoiceRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    voiceRepo = new PgVoiceRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function makeRecording(): Promise<string> {
    const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
    const recording = await voiceRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      fileId,
      status: 'pending',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return recording.id;
  }

  it('MERGES provenance into rich transcription metadata (never replaces)', async () => {
    const id = await makeRecording();
    // Simulate the transcription worker's completion write first.
    await voiceRepo.updateStatus(tenant.tenantId, id, 'completed', {
      transcript: 'agent: hi. caller: my AC is broken.',
      metadata: {
        sanitization_version: 'v1',
        canonical_transcript_field: 'transcript',
        correctionApplied: true,
      },
    });

    const stamped = await voiceRepo.stampProvenance(tenant.tenantId, id, 'mixed');
    expect(stamped).not.toBeNull();
    const meta = stamped!.transcriptMetadata as Record<string, unknown>;
    // The stamp landed…
    expect(meta.provenance).toBe('mixed');
    // …and the transcription worker's keys survived (merge, not replace).
    expect(meta.sanitization_version).toBe('v1');
    expect(meta.canonical_transcript_field).toBe('transcript');
    expect(meta.correctionApplied).toBe(true);
  });

  it('stamps a fresh row (metadata column default) and re-stamp overwrites just the key', async () => {
    const id = await makeRecording();
    const first = await voiceRepo.stampProvenance(tenant.tenantId, id, 'caller');
    expect((first!.transcriptMetadata as Record<string, unknown>).provenance).toBe('caller');

    const second = await voiceRepo.stampProvenance(tenant.tenantId, id, 'operator');
    expect((second!.transcriptMetadata as Record<string, unknown>).provenance).toBe('operator');
  });

  it('is tenant-isolated: stamping under another tenant touches nothing', async () => {
    const id = await makeRecording();
    const otherTenant = await createTestTenant(pool);
    const result = await voiceRepo.stampProvenance(otherTenant.tenantId, id, 'operator');
    expect(result).toBeNull();

    const row = await voiceRepo.findById(tenant.tenantId, id);
    expect((row!.transcriptMetadata as Record<string, unknown> | undefined)?.provenance).toBeUndefined();
  });

  it('round-trips into the fail-closed classifier the way readers will use it', async () => {
    const id = await makeRecording();
    // Unstamped in-app recording → untrusted (fail closed).
    const before = await voiceRepo.findById(tenant.tenantId, id);
    expect(
      classifyRecordingProvenance({
        source: before!.source ?? 'inapp_voice',
        transcriptMetadata: before!.transcriptMetadata ?? null,
      }),
    ).toBe('untrusted');

    // Verified operator-only stamp on an in-app memo → trusted.
    await voiceRepo.stampProvenance(tenant.tenantId, id, 'operator');
    const after = await voiceRepo.findById(tenant.tenantId, id);
    expect(
      classifyRecordingProvenance({
        source: after!.source ?? 'inapp_voice',
        transcriptMetadata: after!.transcriptMetadata ?? null,
      }),
    ).toBe('trusted');
  });
});
