import { describe, expect, it } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryQueue } from '../../src/queues/queue';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository, createVoiceRecording } from '../../src/voice/voice-service';

const TENANT_ID = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
const IDEMPOTENCY_KEY = '0f1e2d3c-4b5a-4678-9abc-def012345678';

function buildApp() {
  const queue = new InMemoryQueue();
  const voiceRepo = new InMemoryVoiceRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'session-1',
      tenantId: TENANT_ID,
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use('/api/voice', createVoiceRouter(voiceRepo, queue));
  return { app, queue, voiceRepo };
}

const recordingBody = {
  fileId: 'file-1',
  audioUrl: 'https://files.example.test/voice.m4a',
  idempotencyKey: IDEMPOTENCY_KEY,
};

describe('POST /api/voice/recordings — idempotency (U11)', () => {
  it('persists the client key on the recording', async () => {
    const { app, voiceRepo } = buildApp();

    const response = await request(app).post('/api/voice/recordings').send(recordingBody);

    expect(response.status).toBe(202);
    const stored = await voiceRepo.findByIdempotencyKey(TENANT_ID, IDEMPOTENCY_KEY);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(response.body.recording.id);
  });

  it('replays the same key to the original recording with one effective queue job', async () => {
    const { app, queue } = buildApp();

    const first = await request(app).post('/api/voice/recordings').send(recordingBody);
    const second = await request(app).post('/api/voice/recordings').send(recordingBody);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.recording.id).toBe(first.body.recording.id);
    // The replay re-sends with the same stable dedupe key; the queue's
    // idempotency absorbs it, leaving exactly one pending transcription job.
    expect(queue.size()).toBe(1);
  });

  it('re-enqueues a stranded pending recording (create-then-crash replay)', async () => {
    const { app, queue, voiceRepo } = buildApp();
    // Simulate the original request dying between create and queue.send:
    // the row exists (pending, key persisted) but no job was enqueued.
    const stranded = await voiceRepo.create(
      createVoiceRecording({
        tenantId: TENANT_ID,
        fileId: 'file-1',
        createdBy: 'user-1',
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );
    expect(queue.size()).toBe(0);

    const response = await request(app).post('/api/voice/recordings').send(recordingBody);

    expect(response.status).toBe(202);
    expect(response.body.recording.id).toBe(stranded.id);
    expect(response.body.queueMessageId).toEqual(expect.any(String));
    expect(queue.size()).toBe(1);
  });

  it('does not re-enqueue a recording that already left pending', async () => {
    const { app, queue, voiceRepo } = buildApp();
    const done = await voiceRepo.create(
      createVoiceRecording({
        tenantId: TENANT_ID,
        fileId: 'file-1',
        createdBy: 'user-1',
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    );
    await voiceRepo.updateStatus(TENANT_ID, done.id, 'completed', { transcript: 'done' });

    const response = await request(app).post('/api/voice/recordings').send(recordingBody);

    expect(response.status).toBe(202);
    expect(response.body.recording.id).toBe(done.id);
    expect(response.body.recording.status).toBe('completed');
    expect(response.body.queueMessageId).toBeNull();
    expect(queue.size()).toBe(0);
  });

  it('keeps create-always semantics when no key is sent (backward compatible)', async () => {
    const { app, queue } = buildApp();
    const body = { fileId: 'file-1', audioUrl: 'https://files.example.test/voice.m4a' };

    const first = await request(app).post('/api/voice/recordings').send(body);
    const second = await request(app).post('/api/voice/recordings').send(body);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.recording.id).not.toBe(first.body.recording.id);
    expect(queue.size()).toBe(2);
  });

  it('rejects a malformed key before any create or queue work', async () => {
    const { app, queue, voiceRepo } = buildApp();

    const response = await request(app)
      .post('/api/voice/recordings')
      .send({ ...recordingBody, idempotencyKey: 'short' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(queue.size()).toBe(0);
    expect(await voiceRepo.findByIdempotencyKey(TENANT_ID, 'short')).toBeNull();
  });
});
