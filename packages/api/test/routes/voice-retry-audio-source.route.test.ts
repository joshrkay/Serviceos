import { describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryFileRepository, type FileRecord, type StorageProvider } from '../../src/files/file-service';
import { InMemoryQueue } from '../../src/queues/queue';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository, type VoiceRecording } from '../../src/voice/voice-service';

const TENANT = '0b3c1f52-7e0d-4d1a-9a8e-12480000000a';
const RECORDING = '5a0f3c9e-1d2b-4c7a-8e6f-124800000001';
const FILE = '6b1f3c9e-1d2b-4c7a-8e6f-124800000001';
const SERVER_URL = 'https://storage.example.test/server-owned.m4a?signature=fresh';

function appFor(
  voiceRepo: InMemoryVoiceRepository,
  queue: InMemoryQueue,
  fileRepo: InMemoryFileRepository,
  storage: StorageProvider,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'owner-1248',
      sessionId: 'session-1248',
      tenantId: TENANT,
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use('/api/voice', createVoiceRouter(voiceRepo, queue, undefined, undefined, undefined, { fileRepo, storage }));
  return app;
}

describe('#1248 — transcription retry audio is selected from server-owned records', () => {
  it('ignores a client-supplied audioUrl and enqueues a fresh URL for the recording file', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    await voiceRepo.create({
      id: RECORDING,
      tenantId: TENANT,
      fileId: FILE,
      source: 'inapp_voice',
      status: 'failed',
      createdBy: 'owner-1248',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as VoiceRecording);
    const fileRepo = new InMemoryFileRepository();
    await fileRepo.create({
      id: FILE,
      tenantId: TENANT,
      filename: 'memo.m4a',
      contentType: 'audio/mp4',
      sizeBytes: 1024,
      storageBucket: 'voice',
      storageKey: `${TENANT}/${FILE}/memo.m4a`,
      uploadedBy: 'owner-1248',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as FileRecord);
    const generateDownloadUrl = vi.fn(async () => SERVER_URL);
    const storage = { generateDownloadUrl } as unknown as StorageProvider;
    const queue = new InMemoryQueue();

    const response = await request(appFor(voiceRepo, queue, fileRepo, storage))
      .post(`/api/voice/recordings/${RECORDING}/retry`)
      .send({ audioUrl: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' });

    expect(response.status).toBe(202);
    expect(generateDownloadUrl).toHaveBeenCalledWith('voice', `${TENANT}/${FILE}/memo.m4a`);
    const jobs = await queue.receiveBatch<Record<string, unknown>>(10);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({
      tenantId: TENANT,
      recordingId: RECORDING,
      audioUrl: SERVER_URL,
      retryRequestedBy: 'owner-1248',
    });
  });
});
