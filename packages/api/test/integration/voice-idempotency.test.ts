import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { getSharedTestDb, createTestTenant, createTestFile, closeSharedTestDb } from './shared';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryQueue } from '../../src/queues/queue';
import { createVoiceRouter } from '../../src/routes/voice';
import { PgVoiceRepository } from '../../src/voice/pg-voice';
import { createVoiceRecording } from '../../src/voice/voice-service';

function buildApp(voiceRepo: PgVoiceRepository, tenant: { tenantId: string; userId: string }) {
  const queue = new InMemoryQueue();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: tenant.userId,
      sessionId: 'session-1',
      tenantId: tenant.tenantId,
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use('/api/voice', createVoiceRouter(voiceRepo, queue));
  // asyncRoute forwards throws to next(err); keep them visible as 500s.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'INTERNAL', message: err.message });
  });
  return { app, queue };
}

describe('Postgres integration — voice recording idempotency (U11)', () => {
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

  it('replays the same key to one row, same 202 envelope, one effective job', async () => {
    const { app, queue } = buildApp(voiceRepo, tenant);
    const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
    const key = crypto.randomUUID();
    const body = { fileId, audioUrl: 'https://files.example.test/a.m4a', idempotencyKey: key };

    const first = await request(app).post('/api/voice/recordings').send(body);
    const second = await request(app).post('/api/voice/recordings').send(body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.recording.id).toBe(first.body.recording.id);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM voice_recordings WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.tenantId, key],
    );
    expect(rows[0].n).toBe(1);
    // The replay's re-send used the same stable dedupe key, so the queue
    // absorbed it: exactly one effective transcription job.
    expect(queue.size()).toBe(1);
  });

  it('re-enqueues on replay of a create-then-crash row so the recording can complete', async () => {
    const { app, queue } = buildApp(voiceRepo, tenant);
    const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
    const key = crypto.randomUUID();

    // Row exists (pending, key persisted) but the original request died
    // before queue.send — no job anywhere.
    const stranded = await voiceRepo.create(
      createVoiceRecording({
        tenantId: tenant.tenantId,
        fileId,
        createdBy: tenant.userId,
        idempotencyKey: key,
      }),
    );
    expect(queue.size()).toBe(0);

    const replay = await request(app)
      .post('/api/voice/recordings')
      .send({ fileId, audioUrl: 'https://files.example.test/b.m4a', idempotencyKey: key });

    expect(replay.status).toBe(202);
    expect(replay.body.recording.id).toBe(stranded.id);
    expect(replay.body.queueMessageId).toEqual(expect.any(String));
    expect(queue.size()).toBe(1);

    const message = await queue.receive<{ recordingId: string }>();
    expect(message?.payload.recordingId).toBe(stranded.id);
  });

  it('scopes uniqueness per tenant — two tenants may share a key value', async () => {
    const otherTenant = await createTestTenant(pool);
    const key = crypto.randomUUID();
    const fileA = await createTestFile(pool, tenant.tenantId, tenant.userId);
    const fileB = await createTestFile(pool, otherTenant.tenantId, otherTenant.userId);

    const recA = await voiceRepo.create(
      createVoiceRecording({
        tenantId: tenant.tenantId,
        fileId: fileA,
        createdBy: tenant.userId,
        idempotencyKey: key,
      }),
    );
    const recB = await voiceRepo.create(
      createVoiceRecording({
        tenantId: otherTenant.tenantId,
        fileId: fileB,
        createdBy: otherTenant.userId,
        idempotencyKey: key,
      }),
    );

    expect(recA.id).not.toBe(recB.id);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM voice_recordings WHERE idempotency_key = $1`,
      [key],
    );
    expect(rows[0].n).toBe(2);
  });

  it('rejects a duplicate key inside one tenant at the database level', async () => {
    const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
    const key = crypto.randomUUID();

    await voiceRepo.create(
      createVoiceRecording({
        tenantId: tenant.tenantId,
        fileId,
        createdBy: tenant.userId,
        idempotencyKey: key,
      }),
    );

    await expect(
      voiceRepo.create(
        createVoiceRecording({
          tenantId: tenant.tenantId,
          fileId,
          createdBy: tenant.userId,
          idempotencyKey: key,
        }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('still allows unkeyed rows to repeat (partial index exempts NULL)', async () => {
    const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);

    const first = await voiceRepo.create(
      createVoiceRecording({ tenantId: tenant.tenantId, fileId, createdBy: tenant.userId }),
    );
    const second = await voiceRepo.create(
      createVoiceRecording({ tenantId: tenant.tenantId, fileId, createdBy: tenant.userId }),
    );

    expect(first.id).not.toBe(second.id);
  });

  it('isolates key lookups across tenants (RLS + tenant scoping)', async () => {
    const otherTenant = await createTestTenant(pool);
    const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
    const key = crypto.randomUUID();

    await voiceRepo.create(
      createVoiceRecording({
        tenantId: tenant.tenantId,
        fileId,
        createdBy: tenant.userId,
        idempotencyKey: key,
      }),
    );

    expect(await voiceRepo.findByIdempotencyKey(tenant.tenantId, key)).not.toBeNull();
    expect(await voiceRepo.findByIdempotencyKey(otherTenant.tenantId, key)).toBeNull();
  });
});
