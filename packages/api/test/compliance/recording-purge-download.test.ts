/**
 * RV-132 (audit item 5) — purged-recording download safety.
 *
 * The retention worker deletes the stored audio object but KEEPS the
 * voice_recordings row (tombstoned via purged_at) and its files FK target.
 * The audio download endpoint must answer a clear 410 GONE for a purged
 * recording instead of minting a presigned URL that 404s at S3 — and the
 * transcription retry endpoint must refuse to send the worker after the
 * deleted object.
 */
import { describe, it, expect, vi } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';
import type { Queue } from '../../src/queues/queue';
import type { FileRepository, StorageProvider } from '../../src/files/file-service';

const TENANT = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
// Recording ids are uuids in production (voice_recordings.id uuid); the routes
// under test guard a malformed :id with a 404 (#1110), so fixtures use real ones.
const REC_ID = '0f7b2a4e-3c1d-4e8a-9b6f-5d2c1a0e9f41';
const REC_NOFILE_ID = '6c9e1d2b-8a4f-4b3e-a7d5-2e1f0c9b8a73';
const UNKNOWN_REC_ID = 'b4d3c2a1-9e8f-4a7b-8c6d-5e4f3a2b1c0d';

function makeQueue(): Queue {
  return { send: vi.fn(async () => 'queued-1') } as unknown as Queue;
}

function makeStorage(): StorageProvider {
  return {
    generateUploadUrl: vi.fn(async () => 'https://s3.test/upload'),
    generateDownloadUrl: vi.fn(async () => 'https://s3.test/download?sig=abc'),
    getObjectMetadata: vi.fn(async () => null),
    getObject: vi.fn(async () => null),
    deleteObject: vi.fn(async () => undefined),
  } as unknown as StorageProvider;
}

function makeFileRepo(): FileRepository {
  return {
    findById: vi.fn(async (_tenantId: string, id: string) =>
      id === 'file-1'
        ? {
            id: 'file-1',
            tenantId: TENANT,
            filename: 'CA-1.mp3',
            contentType: 'audio/mpeg',
            sizeBytes: 1234,
            storageBucket: 'serviceos-recordings',
            storageKey: 'rec/CA-1.mp3',
            uploadedBy: 'twilio-recording-webhook',
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null,
    ),
  } as unknown as FileRepository;
}

function buildApp(opts: {
  voiceRepo: InMemoryVoiceRepository;
  storage?: StorageProvider;
  fileRepo?: FileRepository;
}) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-1',
      sessionId: 'sess-1',
      tenantId: TENANT,
      role: 'owner',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use(
    '/api/voice',
    createVoiceRouter(opts.voiceRepo, makeQueue(), undefined, undefined, undefined, {
      ...(opts.fileRepo ? { fileRepo: opts.fileRepo } : {}),
      ...(opts.storage ? { storage: opts.storage } : {}),
    }),
  );
  return app;
}

async function seedRecording(
  voiceRepo: InMemoryVoiceRepository,
  overrides: Partial<Parameters<InMemoryVoiceRepository['create']>[0]> = {},
) {
  return voiceRepo.create({
    id: REC_ID,
    tenantId: TENANT,
    fileId: 'file-1',
    callSid: 'CA-1',
    status: 'completed',
    transcript: 'hello there',
    createdBy: 'twilio-recording-webhook',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

describe('RV-132 — GET /api/voice/recordings/:id/audio', () => {
  it('returns a presigned download URL for an unpurged recording', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    await seedRecording(voiceRepo);
    const storage = makeStorage();
    const app = buildApp({ voiceRepo, storage, fileRepo: makeFileRepo() });

    const res = await request(app).get(`/api/voice/recordings/${REC_ID}/audio`);
    expect(res.status).toBe(200);
    expect(res.body.downloadUrl).toBe('https://s3.test/download?sig=abc');
    expect(storage.generateDownloadUrl).toHaveBeenCalledWith(
      'serviceos-recordings',
      'rec/CA-1.mp3',
    );
  });

  it('answers 410 RECORDING_PURGED for a purged recording — no S3 URL is minted', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    const purgedAt = new Date('2026-01-15T00:00:00Z');
    await seedRecording(voiceRepo, { purgedAt });
    const storage = makeStorage();
    const app = buildApp({ voiceRepo, storage, fileRepo: makeFileRepo() });

    const res = await request(app).get(`/api/voice/recordings/${REC_ID}/audio`);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('RECORDING_PURGED');
    expect(res.body.purgedAt).toBe(purgedAt.toISOString());
    expect(storage.generateDownloadUrl).not.toHaveBeenCalled();
  });

  it('purge keeps the metadata row readable: GET /recordings/:id still 200s with the transcript', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    await seedRecording(voiceRepo, { purgedAt: new Date() });
    const app = buildApp({ voiceRepo, storage: makeStorage(), fileRepo: makeFileRepo() });

    const res = await request(app).get(`/api/voice/recordings/${REC_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.transcript).toBe('hello there');
  });

  it('404s for an unknown recording and for a recording without a stored file', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    await seedRecording(voiceRepo, { id: REC_NOFILE_ID, fileId: undefined });
    const app = buildApp({ voiceRepo, storage: makeStorage(), fileRepo: makeFileRepo() });

    expect((await request(app).get(`/api/voice/recordings/${UNKNOWN_REC_ID}/audio`)).status).toBe(404);
    expect((await request(app).get(`/api/voice/recordings/${REC_NOFILE_ID}/audio`)).status).toBe(404);
  });

  it('501s when the download deps are not configured', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    await seedRecording(voiceRepo);
    const app = buildApp({ voiceRepo });
    const res = await request(app).get(`/api/voice/recordings/${REC_ID}/audio`);
    expect(res.status).toBe(501);
  });
});

describe('RV-132 — POST /api/voice/recordings/:id/retry on a purged recording', () => {
  it('answers 410 instead of re-enqueueing transcription against the deleted object', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    await seedRecording(voiceRepo, { purgedAt: new Date() });
    const app = buildApp({ voiceRepo, storage: makeStorage(), fileRepo: makeFileRepo() });

    const res = await request(app)
      .post(`/api/voice/recordings/${REC_ID}/retry`)
      .send({ audioUrl: 'https://s3.test/rec/CA-1.mp3' });
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('RECORDING_PURGED');
    // Status untouched — the row stays a completed tombstone.
    const rec = await voiceRepo.findById(TENANT, REC_ID);
    expect(rec!.status).toBe('completed');
  });
});
