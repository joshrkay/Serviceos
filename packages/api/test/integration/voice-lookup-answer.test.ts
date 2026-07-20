/**
 * U3 (iOS blueprint) — E-lane answer persistence on REAL columns.
 *
 * Pins migration 259 (voice_recordings.answer_status + answer) and the
 * PgVoiceRepository answer paths against a real Postgres:
 *   - the two-phase poll contract (status='completed' coexists with
 *     answerStatus='pending' until the router stamps an outcome),
 *   - write-once semantics (a terminal outcome can't be clobbered by a
 *     redelivered stamp; 'failed' stays writable for the retry path),
 *   - tenant isolation on the new columns,
 *   - the answer_status CHECK constraint.
 *
 * CLAUDE.md: tests that mock the DB are never the only proof a query
 * works — the worker-level tests use InMemoryVoiceRepository, so the
 * real column names/JSONB round-trip are pinned here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { VoiceLookupAnswer } from '@ai-service-os/shared';
import { getSharedTestDb, createTestTenant, createTestFile, closeSharedTestDb } from './shared';
import { PgVoiceRepository } from '../../src/voice/pg-voice';
import { createVoiceRecording } from '../../src/voice/voice-service';

const ANSWER: VoiceLookupAnswer = {
  version: 1,
  intent: 'lookup_balance',
  result: 'found',
  summary: 'Your current balance is $123.00 across 2 open invoices.',
  rows: [
    { kind: 'money', label: 'Outstanding balance', amountCents: 12300 },
    { kind: 'count', label: 'Open invoices', count: 2 },
  ],
  entityRef: { kind: 'customer', id: '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1' },
};

describe('Postgres integration — voice lookup answers (U3)', () => {
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

  async function seedRecording() {
    const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
    return voiceRepo.create(
      createVoiceRecording({
        tenantId: tenant.tenantId,
        fileId,
        createdBy: tenant.userId,
      }),
    );
  }

  it('creates the in-app memo with answerStatus=pending on the real column', async () => {
    const recording = await seedRecording();
    expect(recording.answerStatus).toBe('pending');
    expect(recording.answer).toBeUndefined();

    const found = await voiceRepo.findById(tenant.tenantId, recording.id);
    expect(found?.answerStatus).toBe('pending');
  });

  it('holds the two-phase contract: completed + answerStatus=pending, then answered', async () => {
    const recording = await seedRecording();

    // Phase 1 — transcription completes BEFORE the router job even runs.
    const completed = await voiceRepo.updateStatus(tenant.tenantId, recording.id, 'completed', {
      transcript: 'what is my balance',
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.answerStatus).toBe('pending');

    // Phase 2 — the router stamps the routed outcome + JSONB answer.
    const answered = await voiceRepo.recordAnswer(tenant.tenantId, recording.id, {
      answerStatus: 'answered',
      answer: ANSWER,
    });
    expect(answered?.answerStatus).toBe('answered');
    expect(answered?.answer).toEqual(ANSWER);

    // Round-trip through a fresh read: JSONB shape (incl. integer cents)
    // survives the real column.
    const reread = await voiceRepo.findById(tenant.tenantId, recording.id);
    expect(reread?.status).toBe('completed');
    expect(reread?.answerStatus).toBe('answered');
    expect(reread?.answer).toEqual(ANSWER);
  });

  it('is write-once: a redelivered stamp cannot clobber a terminal outcome', async () => {
    const recording = await seedRecording();

    const first = await voiceRepo.recordAnswer(tenant.tenantId, recording.id, {
      answerStatus: 'proposal',
    });
    expect(first?.answerStatus).toBe('proposal');

    // Redelivery races land on the guard and match zero rows.
    const second = await voiceRepo.recordAnswer(tenant.tenantId, recording.id, {
      answerStatus: 'answered',
      answer: ANSWER,
    });
    expect(second).toBeNull();

    const reread = await voiceRepo.findById(tenant.tenantId, recording.id);
    expect(reread?.answerStatus).toBe('proposal');
    expect(reread?.answer).toBeUndefined();
  });

  it("keeps 'failed' writable so a transcription retry can land a fresh outcome", async () => {
    const recording = await seedRecording();

    await voiceRepo.recordAnswer(tenant.tenantId, recording.id, { answerStatus: 'failed' });
    const retried = await voiceRepo.recordAnswer(tenant.tenantId, recording.id, {
      answerStatus: 'answered',
      answer: ANSWER,
    });
    expect(retried?.answerStatus).toBe('answered');
    expect(retried?.answer).toEqual(ANSWER);
  });

  it('tenant-isolates the answer write and read', async () => {
    const recording = await seedRecording();
    const otherTenant = await createTestTenant(pool);

    // Cross-tenant write: no row matched, nothing persisted.
    const crossWrite = await new PgVoiceRepository(pool).recordAnswer(
      otherTenant.tenantId,
      recording.id,
      { answerStatus: 'answered', answer: ANSWER },
    );
    expect(crossWrite).toBeNull();

    // Cross-tenant read: invisible.
    const crossRead = await voiceRepo.findById(otherTenant.tenantId, recording.id);
    expect(crossRead).toBeNull();

    // Same-tenant state untouched by the failed cross-tenant write.
    const sameRead = await voiceRepo.findById(tenant.tenantId, recording.id);
    expect(sameRead?.answerStatus).toBe('pending');
    expect(sameRead?.answer).toBeUndefined();
  });

  it('rejects an out-of-enum answer_status at the DB (CHECK constraint)', async () => {
    const recording = await seedRecording();
    await expect(
      pool.query(
        `UPDATE voice_recordings SET answer_status = 'bogus'
          WHERE id = $1 AND tenant_id = $2`,
        [recording.id, tenant.tenantId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});
