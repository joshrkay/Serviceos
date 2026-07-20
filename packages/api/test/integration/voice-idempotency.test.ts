/**
 * U11 (iOS blueprint, offline prerequisite) — voice create idempotency on
 * REAL columns.
 *
 * Pins migration 260 (voice_recordings.idempotency_key + the partial unique
 * index (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL) and
 * the POST /api/voice/recordings replay path against a real Postgres:
 *   - same key twice → ONE row, the ORIGINAL recording id returned in the
 *     same 202 envelope, exactly ONE effective transcription job (the queue's
 *     own dedupe absorbs the re-send),
 *   - create-then-crash replay (row exists, no job was ever enqueued) → the
 *     replay re-enqueues so the recording can complete instead of stranding
 *     in 'pending' forever,
 *   - tenant isolation: the same key VALUE in two tenants yields two
 *     independent rows (uniqueness is scoped to tenant_id),
 *   - different keys in one tenant → different rows.
 *
 * CLAUDE.md: tests that mock the DB are never the only proof a query works —
 * the handler-level tests use InMemoryVoiceRepository, so the real column
 * names, the partial unique index, and findByIdempotencyKey are pinned here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, createTestFile, closeSharedTestDb } from './shared';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { createVoiceRouter } from '../../src/routes/voice';
import { PgVoiceRepository } from '../../src/voice/pg-voice';
import { createVoiceRecording } from '../../src/voice/voice-service';
import { InMemoryQueue } from '../../src/queues/queue';

interface TestApp {
  app: express.Express;
  queue: InMemoryQueue;
}

function buildApp(pool: Pool, tenantId: string, userId: string): TestApp {
  const voiceRepo = new PgVoiceRepository(pool);
  const queue = new InMemoryQueue();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId,
      sessionId: 'session-1',
      tenantId,
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use('/api/voice', createVoiceRouter(voiceRepo, queue));
  return { app, queue };
}

describe('Postgres integration — voice create idempotency (U11)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let fileId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  function body(idempotencyKey: string) {
    return {
      fileId,
      audioUrl: 'https://files.example.test/voice.m4a',
      idempotencyKey,
    };
  }

  async function countRows(tenantId: string, key: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM voice_recordings
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key],
    );
    return Number(rows[0].n);
  }

  it('same key twice → one row, same recording id, exactly one effective job', async () => {
    const { app, queue } = buildApp(pool, tenant.tenantId, tenant.userId);
    const key = `same-${crypto.randomUUID()}`;

    const first = await request(app).post('/api/voice/recordings').send(body(key));
    expect(first.status).toBe(202);
    const originalId = first.body.recording.id as string;

    const replay = await request(app).post('/api/voice/recordings').send(body(key));
    expect(replay.status).toBe(202);
    expect(replay.body.recording.id).toBe(originalId);

    // Exactly one row persisted for the key.
    expect(await countRows(tenant.tenantId, key)).toBe(1);
    // The re-send under the same stable create dedupe key is absorbed by the
    // queue while the first job is still pending → one effective job.
    expect(queue.size()).toBe(1);
  });

  it('create-then-crash replay (row exists, no job) re-enqueues so the recording can complete', async () => {
    const { app, queue } = buildApp(pool, tenant.tenantId, tenant.userId);
    const voiceRepo = new PgVoiceRepository(pool);
    const key = `crash-${crypto.randomUUID()}`;

    // Simulate the original request dying AFTER voiceRepo.create but BEFORE
    // the queue send: the row exists, but no transcription job was enqueued.
    const stranded = await voiceRepo.create(
      createVoiceRecording({
        tenantId: tenant.tenantId,
        fileId,
        createdBy: tenant.userId,
        idempotencyKey: key,
      }),
    );
    expect(queue.size()).toBe(0);

    // The replay must NOT mint a duplicate, and MUST re-enqueue so the
    // stranded 'pending' recording actually gets transcribed.
    const replay = await request(app).post('/api/voice/recordings').send(body(key));
    expect(replay.status).toBe(202);
    expect(replay.body.recording.id).toBe(stranded.id);

    expect(await countRows(tenant.tenantId, key)).toBe(1);
    expect(queue.size()).toBe(1);

    // The re-enqueued job targets the original stranded recording.
    const message = await queue.receive<{ recordingId: string }>();
    expect(message?.payload.recordingId).toBe(stranded.id);
    expect(message?.idempotencyKey).toBe(
      `${tenant.tenantId}:${stranded.id}:transcription:create`,
    );
  });

  it('tenant-isolates the key: the same value in two tenants → two independent rows', async () => {
    const other = await createTestTenant(pool);
    const otherFileId = await createTestFile(pool, other.tenantId, other.userId);
    const appA = buildApp(pool, tenant.tenantId, tenant.userId);
    const appB = express();
    appB.use(express.json());
    appB.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: other.userId,
        sessionId: 'session-1',
        tenantId: other.tenantId,
        role: 'owner',
      } as AuthenticatedRequest['auth'];
      next();
    });
    appB.use('/api/voice', createVoiceRouter(new PgVoiceRepository(pool), new InMemoryQueue()));

    const key = `shared-${crypto.randomUUID()}`;

    const inA = await request(appA.app).post('/api/voice/recordings').send(body(key));
    const inB = await request(appB)
      .post('/api/voice/recordings')
      .send({ fileId: otherFileId, audioUrl: 'https://files.example.test/b.m4a', idempotencyKey: key });

    expect(inA.status).toBe(202);
    expect(inB.status).toBe(202);
    // Two independent recordings — uniqueness is scoped to tenant_id.
    expect(inA.body.recording.id).not.toBe(inB.body.recording.id);
    expect(await countRows(tenant.tenantId, key)).toBe(1);
    expect(await countRows(other.tenantId, key)).toBe(1);
  });

  it('different keys in one tenant → different rows', async () => {
    const { app } = buildApp(pool, tenant.tenantId, tenant.userId);
    const keyA = `diff-a-${crypto.randomUUID()}`;
    const keyB = `diff-b-${crypto.randomUUID()}`;

    const a = await request(app).post('/api/voice/recordings').send(body(keyA));
    const b = await request(app).post('/api/voice/recordings').send(body(keyB));

    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body.recording.id).not.toBe(b.body.recording.id);
    expect(await countRows(tenant.tenantId, keyA)).toBe(1);
    expect(await countRows(tenant.tenantId, keyB)).toBe(1);
  });
});
