/**
 * H2 (2026-10-13 security audit) — POST /api/voice/recordings audio is
 * selected from server-owned records, mirroring the #1248 retry fix.
 *
 * The create route used to enqueue the client's `audioUrl` verbatim, and the
 * transcription worker fetched it from inside the API process: any caller
 * with `files:upload` could make the server GET internal addresses (cloud
 * metadata, localhost, the private network) and read the HTTP status back
 * through the recording's errorMessage. The route now resolves the
 * tenant-scoped files row named by `fileId` and mints the download URL
 * itself; the client `audioUrl` is never enqueued.
 */
import { describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import {
  InMemoryFileRepository,
  type FileRecord,
  type StorageProvider,
} from '../../src/files/file-service';
import { InMemoryQueue } from '../../src/queues/queue';
import { createVoiceRouter } from '../../src/routes/voice';
import { InMemoryVoiceRepository } from '../../src/voice/voice-service';

const TENANT = '0b3c1f52-7e0d-4d1a-9a8e-1248000000a2';
const FILE = '6b1f3c9e-1d2b-4c7a-8e6f-1248000000a2';
const SERVER_URL = 'https://storage.example.test/server-owned.m4a?X-Amz-Signature=fresh';

const HOSTILE_AUDIO_URLS = [
  'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
  'http://localhost:9000/admin',
  'http://10.0.0.7:5432/',
  'http://api.railway.internal:8080/health',
  'https://user:pass@storage.example.test/server-owned.m4a',
  'https://attacker.example/huge-response.bin',
];

function audioFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: FILE,
    tenantId: TENANT,
    filename: 'memo.m4a',
    contentType: 'audio/mp4',
    sizeBytes: 1024,
    storageBucket: 'voice',
    storageKey: `${TENANT}/${FILE}/memo.m4a`,
    // What /api/files/upload-url writes for web (AssistantPage, VoiceBar)
    // and mobile (uploadAndTranscribe): entityType 'voice_recording',
    // uploadedBy = the authenticated caller's userId.
    entityType: 'voice_recording',
    uploadedBy: 'tech-h2',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as FileRecord;
}

async function harness(files: FileRecord[] = [audioFile()]) {
  const voiceRepo = new InMemoryVoiceRepository();
  const fileRepo = new InMemoryFileRepository();
  for (const f of files) await fileRepo.create(f);
  const generateDownloadUrl = vi.fn(async () => SERVER_URL);
  const storage = { generateDownloadUrl } as unknown as StorageProvider;
  const queue = new InMemoryQueue();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'tech-h2',
      sessionId: 'session-h2',
      tenantId: TENANT,
      role: 'technician',
    } as AuthenticatedRequest['auth'];
    next();
  });
  app.use(
    '/api/voice',
    createVoiceRouter(voiceRepo, queue, undefined, undefined, undefined, { fileRepo, storage }),
  );
  return { app, queue, voiceRepo, generateDownloadUrl };
}

describe('H2 — POST /api/voice/recordings selects audio from server-owned records', () => {
  it.each(HOSTILE_AUDIO_URLS)(
    'ignores client audioUrl %s and enqueues a URL minted for the tenant file',
    async (audioUrl) => {
      const { app, queue, generateDownloadUrl } = await harness();

      const response = await request(app)
        .post('/api/voice/recordings')
        .send({ fileId: FILE, audioUrl });

      expect(response.status).toBe(202);
      expect(generateDownloadUrl).toHaveBeenCalledWith('voice', `${TENANT}/${FILE}/memo.m4a`);
      const jobs = await queue.receiveBatch<Record<string, unknown>>(10);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toMatchObject({ tenantId: TENANT, audioUrl: SERVER_URL });
      expect(JSON.stringify(jobs[0].payload)).not.toContain(audioUrl);
    },
  );

  it.each([
    ['belongs to another tenant', audioFile({ tenantId: 'f0000000-0000-4000-8000-0000000000ff' })],
    ['does not exist', null],
  ])('404s and enqueues nothing when fileId %s', async (_label, seeded) => {
    const { app, queue, voiceRepo, generateDownloadUrl } = await harness(seeded ? [seeded] : []);
    const create = vi.spyOn(voiceRepo, 'create');

    const response = await request(app)
      .post('/api/voice/recordings')
      .send({ fileId: FILE, audioUrl: 'http://169.254.169.254/latest/meta-data/' });

    expect(response.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
    expect(generateDownloadUrl).not.toHaveBeenCalled();
    expect(await queue.receiveBatch(10)).toHaveLength(0);
  });

  it('an idempotent replay re-enqueues a URL minted for the original recording file, not the replayed audioUrl', async () => {
    const { app, queue, generateDownloadUrl } = await harness();
    const first = await request(app)
      .post('/api/voice/recordings')
      .send({ fileId: FILE, audioUrl: 'https://storage.example.test/memo.m4a', idempotencyKey: 'memo-h2' });
    expect(first.status).toBe(202);
    await queue.receiveBatch(10);
    generateDownloadUrl.mockClear();

    const replayUrl = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
    const replay = await request(app)
      .post('/api/voice/recordings')
      .send({ fileId: FILE, audioUrl: replayUrl, idempotencyKey: 'memo-h2' });

    expect(replay.status).toBe(202);
    expect(replay.body.recording.id).toBe(first.body.recording.id);
    expect(generateDownloadUrl).toHaveBeenCalledWith('voice', `${TENANT}/${FILE}/memo.m4a`);
    const jobs = await queue.receiveBatch<Record<string, unknown>>(10);
    expect(jobs.map((j) => j.payload.audioUrl)).toEqual([SERVER_URL]);
  });

  it.each([
    // The Twilio webhooks write voice_recording rows too (voice-service.ts),
    // with a non-user uploader: caller audio must not become an operator memo.
    ['a voicemail recording', audioFile({ uploadedBy: 'voicemail_webhook' })],
    ['an inbound-call recording', audioFile({ uploadedBy: 'twilio-recording-webhook' })],
    ["another user's memo upload", audioFile({ uploadedBy: 'other-tech' })],
    ['an audio file uploaded for something else', audioFile({ entityType: 'job', entityId: 'job-1' })],
    ['an audio file with no entity type', audioFile({ entityType: undefined })],
  ])('403s and enqueues nothing when fileId is %s', async (_label, seeded) => {
    const { app, queue, voiceRepo, generateDownloadUrl } = await harness([seeded]);
    const create = vi.spyOn(voiceRepo, 'create');

    const response = await request(app)
      .post('/api/voice/recordings')
      .send({ fileId: FILE, audioUrl: 'https://storage.example.test/memo.m4a' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('RECORDING_FILE_NOT_OWNED');
    expect(create).not.toHaveBeenCalled();
    expect(generateDownloadUrl).not.toHaveBeenCalled();
    expect(await queue.receiveBatch(10)).toHaveLength(0);
  });

  it('503s and enqueues nothing when no storage is wired to mint the URL', async () => {
    const voiceRepo = new InMemoryVoiceRepository();
    const create = vi.spyOn(voiceRepo, 'create');
    const queue = new InMemoryQueue();
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: 'tech-h2',
        sessionId: 'session-h2',
        tenantId: TENANT,
        role: 'technician',
      } as AuthenticatedRequest['auth'];
      next();
    });
    app.use('/api/voice', createVoiceRouter(voiceRepo, queue));

    const response = await request(app)
      .post('/api/voice/recordings')
      .send({ fileId: FILE, audioUrl: 'https://attacker.example/audio.m4a' });

    expect(response.status).toBe(503);
    expect(create).not.toHaveBeenCalled();
    expect(await queue.receiveBatch(10)).toHaveLength(0);
  });

  it('409s and enqueues nothing when the file is not audio', async () => {
    const { app, queue, generateDownloadUrl } = await harness([
      audioFile({ contentType: 'application/pdf', filename: 'invoice.pdf' }),
    ]);

    const response = await request(app)
      .post('/api/voice/recordings')
      .send({ fileId: FILE, audioUrl: 'https://storage.example.test/invoice.pdf' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('INVALID_RECORDING_AUDIO');
    expect(generateDownloadUrl).not.toHaveBeenCalled();
    expect(await queue.receiveBatch(10)).toHaveLength(0);
  });
});
